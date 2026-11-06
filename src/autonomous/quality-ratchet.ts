import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { git } from '../git/git.js';
import {
  analyzeFile,
  countAssertionsInFiles,
  defaultRunCommand,
  maxComplexityInFiles,
  type RunCommand,
} from './ast-analysis.js';

export { analyzeFile, countAssertionsInFiles, maxComplexityInFiles };

/**
 * RepoHealthVector — the quality ratchet. Every field is a one-way gate: a task
 * may improve any of them, but it may never make one worse (within the stated
 * tolerances). The daemon captures a baseline before IMPLEMENT and asserts
 * non-degradation in VERIFY.
 */
export interface RepoHealthVector {
  /** tsc errors. Never increase. */
  tscErrorCount: number;
  /** ESLint errors. Never increase. */
  lintErrorCount: number;
  /** ESLint warnings. Never exceed baseline. */
  lintWarningCount: number;
  /** Tests passing in the full suite. Never drop below baseline. */
  passingTestCount: number;
  /** AST count of expect/assert calls across test files. Never drop below baseline. */
  totalAssertionCount: number;
  /** Line coverage %. May dip at most 0.01 below baseline. */
  lineCoveragePct: number;
  /** Branch coverage %. May dip at most 0.01 below baseline. */
  branchCoveragePct: number;
  /** Highest per-function cyclomatic complexity across touched files. Never exceed baseline. */
  maxCyclomaticComplexity: number;
  /** Full-suite wall time. Rolling median; no >10% regression. */
  testSuiteDurationMs: number;
}

export interface HealthViolation {
  metric: keyof RepoHealthVector;
  baseline: number;
  current: number;
  message: string;
}

export interface NonDegradationResult {
  ok: boolean;
  violations: HealthViolation[];
  /** Duration check skipped (too few history samples) rather than passed. */
  durationCheckSkipped: boolean;
}

const COVERAGE_TOLERANCE_PCT = 0.01;
const DURATION_REGRESSION_FACTOR = 1.1;
const MIN_DURATION_SAMPLES = 3;

/**
 * Pure comparison of two health vectors. `durationHistory` is the rolling
 * history of prior suite durations (excluding `current`); the duration gate
 * needs at least 3 samples before it can fire.
 */
export function assertNonDegradationPure(
  baseline: RepoHealthVector,
  current: RepoHealthVector,
  durationHistory: readonly number[] = [],
): NonDegradationResult {
  const violations: HealthViolation[] = [];
  const check = (metric: keyof RepoHealthVector, ok: boolean, message: string): void => {
    if (!ok) {
      violations.push({ metric, baseline: baseline[metric], current: current[metric], message });
    }
  };
  check(
    'tscErrorCount',
    current.tscErrorCount <= baseline.tscErrorCount,
    `tsc errors rose ${baseline.tscErrorCount} → ${current.tscErrorCount}`,
  );
  check(
    'lintErrorCount',
    current.lintErrorCount <= baseline.lintErrorCount,
    `lint errors rose ${baseline.lintErrorCount} → ${current.lintErrorCount}`,
  );
  check(
    'lintWarningCount',
    current.lintWarningCount <= baseline.lintWarningCount,
    `lint warnings rose ${baseline.lintWarningCount} → ${current.lintWarningCount}`,
  );
  check(
    'passingTestCount',
    current.passingTestCount >= baseline.passingTestCount,
    `passing tests fell ${baseline.passingTestCount} → ${current.passingTestCount}`,
  );
  check(
    'totalAssertionCount',
    current.totalAssertionCount >= baseline.totalAssertionCount,
    `assertion count fell ${baseline.totalAssertionCount} → ${current.totalAssertionCount}`,
  );
  check(
    'lineCoveragePct',
    current.lineCoveragePct >= baseline.lineCoveragePct - COVERAGE_TOLERANCE_PCT,
    `line coverage fell ${baseline.lineCoveragePct}% → ${current.lineCoveragePct}%`,
  );
  check(
    'branchCoveragePct',
    current.branchCoveragePct >= baseline.branchCoveragePct - COVERAGE_TOLERANCE_PCT,
    `branch coverage fell ${baseline.branchCoveragePct}% → ${current.branchCoveragePct}%`,
  );
  check(
    'maxCyclomaticComplexity',
    current.maxCyclomaticComplexity <= baseline.maxCyclomaticComplexity,
    `max cyclomatic complexity rose ${baseline.maxCyclomaticComplexity} → ${current.maxCyclomaticComplexity}`,
  );
  let durationCheckSkipped = false;
  if (durationHistory.length >= MIN_DURATION_SAMPLES) {
    const sorted = [...durationHistory].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    check(
      'testSuiteDurationMs',
      current.testSuiteDurationMs <= median * DURATION_REGRESSION_FACTOR,
      `suite duration ${current.testSuiteDurationMs}ms is >10% over rolling median ${median}ms`,
    );
  } else {
    durationCheckSkipped = true;
  }
  return { ok: violations.length === 0, violations, durationCheckSkipped };
}

/** Net-LoC bloat cap: non-coverage tasks adding >150 net lines cannot auto-merge. */
export const BLOAT_NET_LOC_CAP = 150;

export interface BloatCheck {
  netLoc: number;
  exceedsCap: boolean;
  /** True when the task must go to human review instead of auto-merge. */
  needsHumanReview: boolean;
}

export function checkBloat(
  linesAdded: number,
  linesDeleted: number,
  isCoverageTask: boolean,
): BloatCheck {
  const netLoc = linesAdded - linesDeleted;
  const exceedsCap = !isCoverageTask && netLoc > BLOAT_NET_LOC_CAP;
  return { netLoc, exceedsCap, needsHumanReview: exceedsCap };
}

// ---------------------------------------------------------------------------
// Measurement — runs the real tools in a worktree and builds a vector.
// ---------------------------------------------------------------------------

export interface MeasureHealthOptions {
  runCommand?: RunCommand;
  /** Files to lint / measure complexity over. Defaults to src/** + test/**. */
  lintTargets?: readonly string[];
  /** Skip the full vitest run (faster; coverage/test counts stay 0). */
  skipTests?: boolean;
  timeoutMs?: number;
}

interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
}

interface CoverageSummary {
  total?: { lines?: { pct?: number }; branches?: { pct?: number } };
}

function countTscErrors(output: string): number {
  return output.split('\n').filter((line) => /error TS\d+/.test(line)).length;
}

export function listFilesRecursive(
  dir: string,
  ext: readonly string[],
  out: string[] = [],
): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(full, ext, out);
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Measure the current health of a worktree. Runs tsc, ESLint (JSON format) and,
 * unless skipped, the full vitest suite with coverage. All tool failures are
 * reported as counts, never thrown — a broken tree still yields a vector.
 */
export async function measureHealth(
  worktreePath: string,
  opts: MeasureHealthOptions = {},
): Promise<RepoHealthVector> {
  const run = opts.runCommand ?? defaultRunCommand;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const root = resolve(worktreePath);

  const tsc = await run('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: root,
    timeoutMs: 120_000,
  });
  const tscErrorCount = countTscErrors(`${tsc.stdout}\n${tsc.stderr}`);

  const lintTargets = opts.lintTargets ?? ['src', 'test'];
  const eslint = await run('npx', ['eslint', '--format', 'json', ...lintTargets], {
    cwd: root,
    timeoutMs: 120_000,
  });
  let lintErrorCount = 0;
  let lintWarningCount = 0;
  try {
    const parsed: { errorCount?: number; warningCount?: number }[] = JSON.parse(eslint.stdout) as {
      errorCount?: number;
      warningCount?: number;
    }[];
    for (const file of parsed) {
      lintErrorCount += file.errorCount ?? 0;
      lintWarningCount += file.warningCount ?? 0;
    }
  } catch {
    // ESLint unavailable or output unparsable: count the exit code instead.
    if (eslint.exitCode !== 0) lintErrorCount = 1;
  }

  const testFiles = listFilesRecursive(join(root, 'test'), ['.test.ts', '.test.tsx']);
  const srcTestFiles = listFilesRecursive(join(root, 'src'), ['.test.ts', '.test.tsx']);
  const allTestFiles = [...testFiles, ...srcTestFiles];
  const totalAssertionCount = countAssertionsInFiles(allTestFiles);

  const srcFiles = listFilesRecursive(join(root, 'src'), ['.ts', '.tsx']).filter(
    (f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'),
  );
  const maxCyclomaticComplexity = maxComplexityInFiles(srcFiles);

  let passingTestCount = 0;
  let lineCoveragePct = 0;
  let branchCoveragePct = 0;
  let testSuiteDurationMs = 0;
  if (!opts.skipTests) {
    const tmpDir = await mkdtemp(join(tmpdir(), 'omnexx-health-'));
    const reportPath = join(tmpDir, 'vitest.json');
    const suite = await run(
      'npx',
      [
        'vitest',
        'run',
        '--coverage',
        '--coverage.reporter=json-summary',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      { cwd: root, timeoutMs },
    );
    testSuiteDurationMs = suite.durationMs;
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as VitestJsonReport;
      passingTestCount = report.numPassedTests ?? 0;
    } catch {
      passingTestCount = 0;
    }
    try {
      const summary = JSON.parse(
        readFileSync(join(root, 'coverage', 'coverage-summary.json'), 'utf8'),
      ) as CoverageSummary;
      lineCoveragePct = summary.total?.lines?.pct ?? 0;
      branchCoveragePct = summary.total?.branches?.pct ?? 0;
    } catch {
      lineCoveragePct = 0;
      branchCoveragePct = 0;
    }
  }

  return {
    tscErrorCount,
    lintErrorCount,
    lintWarningCount,
    passingTestCount,
    totalAssertionCount,
    lineCoveragePct,
    branchCoveragePct,
    maxCyclomaticComplexity,
    testSuiteDurationMs,
  };
}

// ---------------------------------------------------------------------------
// QualityRatchet — stateful owner of baselines + duration history + macro-audit.
// ---------------------------------------------------------------------------

export interface QualityRatchetOptions {
  runCommand?: RunCommand;
}

export interface MacroAuditOptions {
  /** Worktree/branch the macro-audit may mutate (it reverts the bad commit). */
  worktreePath: string;
  /** Commit the epoch started at — the known-good end of the bisect range. */
  epochStartCommit: string;
  /** E2E command. Defaults to the repo's e2e vitest project. */
  e2eCommand?: readonly string[];
  /** Where to append tombstones. When omitted, the fingerprint is returned only. */
  tombstonePath?: string;
  runCommand?: RunCommand;
  timeoutMs?: number;
}

export interface MacroAuditResult {
  pass: boolean;
  offendingCommit?: string;
  reverted?: boolean;
  tombstoned?: boolean;
  /** sha256 of the offending commit's diff — the fingerprint to never re-ship. */
  fingerprint?: string;
  details: string;
}

export interface Tombstone {
  commit: string;
  fingerprint: string;
  reason: string;
  createdAt: string;
}

export class QualityRatchet {
  private readonly runCommand: RunCommand;
  private readonly durationHistory: number[] = [];

  constructor(opts: QualityRatchetOptions = {}) {
    this.runCommand = opts.runCommand ?? defaultRunCommand;
  }

  /** Capture the health baseline before IMPLEMENT. Also seeds duration history. */
  async captureBaseline(
    worktreePath: string,
    opts: MeasureHealthOptions = {},
  ): Promise<RepoHealthVector> {
    const baseline = await measureHealth(worktreePath, {
      ...opts,
      runCommand: opts.runCommand ?? this.runCommand,
    });
    this.recordDuration(baseline.testSuiteDurationMs);
    return baseline;
  }

  /** Record one suite duration into the rolling history (cap 20 samples). */
  recordDuration(durationMs: number): void {
    if (durationMs > 0) {
      this.durationHistory.push(durationMs);
      if (this.durationHistory.length > 20) this.durationHistory.shift();
    }
  }

  /** VERIFY-side gate: compare a fresh vector against the baseline. */
  assertNonDegradation(
    baseline: RepoHealthVector,
    current: RepoHealthVector,
  ): NonDegradationResult {
    return assertNonDegradationPure(baseline, current, this.durationHistory);
  }

  /** Net-LoC bloat cap for one task's diff. */
  checkBloat(linesAdded: number, linesDeleted: number, isCoverageTask: boolean): BloatCheck {
    return checkBloat(linesAdded, linesDeleted, isCoverageTask);
  }

  /**
   * Macro-audit, run by the daemon every 10 shipped tasks. Runs the full E2E
   * suite; on failure bisects between HEAD and the epoch-start commit, reverts
   * the first bad autonomous commit and tombstones its fingerprint.
   *
   * Mutates the worktree (bisect + revert). Run on a dedicated worktree, not
   * on a live implementation worktree.
   */
  async runMacroAudit(opts: MacroAuditOptions): Promise<MacroAuditResult> {
    const run = opts.runCommand ?? this.runCommand;
    const root = resolve(opts.worktreePath);
    const timeoutMs = opts.timeoutMs ?? 1_800_000;
    const e2e = opts.e2eCommand ?? ['npx', 'vitest', 'run', '--project', 'e2e'];

    const e2eResult = await run(e2e[0] ?? 'npx', e2e.slice(1), { cwd: root, timeoutMs });
    if (e2eResult.exitCode === 0) {
      return { pass: true, details: 'E2E suite green at macro-audit.' };
    }

    // Bisect: HEAD is bad, epochStartCommit is good.
    const bisectDir = await mkdtemp(join(tmpdir(), 'omnexx-bisect-'));
    const scriptPath = join(bisectDir, 'bisect-e2e.sh');
    const script = `#!/bin/sh\ncd ${JSON.stringify(root)}\nexec ${e2e.map((a) => JSON.stringify(a)).join(' ')}\n`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    try {
      await git(root, ['bisect', 'start', 'HEAD', opts.epochStartCommit]);
      const bisect = await git(root, ['bisect', 'run', scriptPath], { allowFailure: true });
      const match = /([0-9a-f]{40}) is the first bad commit/.exec(bisect.stdout);
      const offendingCommit = match?.[1];
      if (!offendingCommit) {
        return {
          pass: false,
          details: `E2E failed but bisect found no first bad commit: ${bisect.stdout.slice(-500)}`,
        };
      }
      const diff = await git(root, ['show', offendingCommit], { allowFailure: true });
      const fingerprint = createHash('sha256').update(diff.stdout).digest('hex');
      const revert = await git(root, ['revert', '--no-edit', offendingCommit], {
        allowFailure: true,
      });
      const reverted = revert.exitCode === 0;
      let tombstoned = false;
      if (opts.tombstonePath) {
        const tombstone: Tombstone = {
          commit: offendingCommit,
          fingerprint,
          reason: 'macro-audit E2E failure',
          createdAt: new Date().toISOString(),
        };
        try {
          const existing: Tombstone[] = existsSync(opts.tombstonePath)
            ? (JSON.parse(readFileSync(opts.tombstonePath, 'utf8')) as Tombstone[])
            : [];
          existing.push(tombstone);
          await mkdir(dirname(resolve(opts.tombstonePath)), { recursive: true }).catch(
            () => undefined,
          );
          writeFileSync(opts.tombstonePath, `${JSON.stringify(existing, null, 2)}\n`);
          tombstoned = true;
        } catch {
          tombstoned = false;
        }
      }
      return {
        pass: false,
        offendingCommit,
        reverted,
        tombstoned,
        fingerprint,
        details: reverted
          ? `E2E failed; first bad commit ${offendingCommit} reverted and tombstoned.`
          : `E2E failed; first bad commit ${offendingCommit} found but revert failed — needs human review.`,
      };
    } finally {
      await git(root, ['bisect', 'reset'], { allowFailure: true });
    }
  }
}
