import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { git } from '../git/git.js';
import { matchesAny } from '../security/glob.js';
import { scanPatchForSecrets } from '../security/secret-scan.js';
import { clipDiff } from '../verify/review.js';
import {
  analyzeSourceText,
  countAssertionsInFiles,
  defaultRunCommand,
  extractExpectations,
  isTestFilePath,
  maxComplexityInFiles,
  type ExpectedAssertion,
  type RunCommand,
} from './ast-analysis.js';
import {
  assertNonDegradationPure,
  BLOAT_NET_LOC_CAP,
  checkBloat,
  listFilesRecursive,
  type RepoHealthVector,
} from './quality-ratchet.js';

/**
 * VerificationPipeline — the 5-stage gate every autonomous task's diff must
 * pass before it can ship. Outcome the daemon acts on:
 * - PASS   → ship (unless `bloatNeedsHumanReview` is set — then human review).
 * - REPAIR → back to IMPLEMENT with diagnostics (max 2 repair rounds).
 * - FAIL   → quarantine. Safety violations (Stage 0) fail immediately.
 *
 * Reuses `clipDiff` from src/verify/review.ts for the critic prompt; the
 * Stage 4 critic is an injected function (no hardcoded provider call) and the
 * secret scan / glob matching come from src/security.
 */

// ---------------------------------------------------------------------------
// Safety denylist — no tool-guard module exists yet in this repo, so the list
// lives here. Keep in sync with the daemon's tool guard when one lands.
// ---------------------------------------------------------------------------

export const SAFETY_DENYLIST: readonly string[] = [
  'omnexx.toml',
  '.omnexx/**',
  'CLAUDE.md',
  'AGENTS.md',
  '.github/**',
  '.env*',
  '*.pem',
  '*.key',
];

export type VerificationTaskKind =
  'test_runner' | 'self_review' | 'coverage_gap' | 'refactor' | 'feature' | 'bugfix' | 'other';

export interface VerificationTask {
  id: string;
  title: string;
  kind: VerificationTaskKind;
  /** The finding / requirement the task was created to address. */
  finding?: string;
  acceptance?: string[];
}

export type VerificationOutcome = 'PASS' | 'REPAIR' | 'FAIL';

export interface StageResult {
  stage: number;
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  details: string;
  diagnostics: string[];
  /** Stage-owned measurements the next stage (or the ratchet) may consume. */
  metrics?: { lintErrors?: number; lintWarnings?: number };
}

export interface VerificationResult {
  outcome: VerificationOutcome;
  /** 0-based repair round this verification ran in (daemon increments per loop). */
  repairRound: number;
  stages: StageResult[];
  diagnostics: string[];
  health?: RepoHealthVector | undefined;
  /** Net-LoC cap tripped: PASS still holds, but the daemon must not auto-merge. */
  bloatNeedsHumanReview: boolean;
  netLoc: number;
}

// ---------------------------------------------------------------------------
// Stage 0 — Diff Hygiene (pure, unit-testable)
// ---------------------------------------------------------------------------

export interface DiffHygieneInput {
  /** Unified diff of the change (tracked files) + synthetic diffs for new files. */
  diff: string;
  changedFiles: readonly string[];
  /** Current blob SHA per changed file (via `git hash-object`), for oscillation. */
  blobShas?: ReadonlyMap<string, string> | undefined;
  /** Blob SHAs a recent autonomous task replaced — restoring one is oscillation. */
  recentBlobHistory?: readonly string[] | undefined;
  /** Assertion count in the changed test files before this task (from HEAD). */
  baselineAssertionCount?: number | undefined;
  /** Read a changed file's current content from the worktree. */
  readFile?: (relPath: string) => string | undefined;
  /**
   * Read a changed file's HEAD content; undefined when the file is new (no
   * HEAD version). Without this the weakened-expectation / test-only checks
   * below cannot compare, so they are skipped — `runStage0` always provides it.
   */
  readHeadFile?: (relPath: string) => string | undefined;
}

export interface DiffHygieneResult {
  clean: boolean;
  violations: string[];
  assertionCount: number;
  changedTestFiles: string[];
}

/**
 * One `expect(...)` assertion whose expected value, asserted expression, or
 * matcher changed between two versions of a test file — or that was removed.
 */
export interface ChangedAssertion {
  file: string;
  testTitle: string;
  matcher: string;
  /** Expected value before the change (`toBe(5)` → `5`). */
  before: string;
  /** Expected value after the change; null when the assertion was removed. */
  after: string | null;
  beforeActual: string;
  afterActual: string | null;
}

/** Module path with its code extension (and a trailing `/index`) stripped, so `src/adder.ts` matches an import of `../src/adder.js`. */
function normalizeModulePath(file: string): string {
  return file.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '').replace(/\/index$/, '');
}

/** Resolve a relative import specifier to a repo-relative module path, or null for bare specifiers. */
export function resolveTestImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const resolved = normalizeModulePath(parts.join('/'));
  return resolved || null;
}

/**
 * Compare the `expect(...).toBe/toEqual/toStrictEqual(<literal>)` assertions
 * in two versions of a test file. Assertions are keyed by test title plus
 * their ordinal within that title, so a reordered test still lines up.
 * Added assertions are NOT reported (adding tests is legitimate); a changed
 * expected value / asserted expression / matcher, or a removed assertion, is.
 * Pure and deterministic — no filesystem access.
 */
export function findChangedAssertions(
  headContent: string,
  currentContent: string,
  file: string,
): ChangedAssertion[] {
  const keyed = (list: ExpectedAssertion[]): Map<string, ExpectedAssertion> => {
    const seen = new Map<string, number>();
    const out = new Map<string, ExpectedAssertion>();
    for (const a of list) {
      const n = (seen.get(a.testTitle) ?? 0) + 1;
      seen.set(a.testTitle, n);
      out.set(`${a.testTitle}\0${n}`, a);
    }
    return out;
  };
  const before = keyed(extractExpectations(headContent, file));
  const after = keyed(extractExpectations(currentContent, file));
  const changed: ChangedAssertion[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      changed.push({
        file,
        testTitle: b.testTitle,
        matcher: b.matcher,
        before: b.expected,
        after: null,
        beforeActual: b.actual,
        afterActual: null,
      });
    } else if (a.matcher !== b.matcher || a.expected !== b.expected || a.actual !== b.actual) {
      changed.push({
        file,
        testTitle: b.testTitle,
        matcher: b.matcher,
        before: b.expected,
        after: a.expected,
        beforeActual: b.actual,
        afterActual: a.actual,
      });
    }
  }
  return changed;
}

/**
 * Forbidden paths, secret scan on added lines, test-file AST checks
 * (assertion count vs baseline, no added `.skip` / `.only`), and the
 * cross-task oscillation check. Pure except for `readFile` / `readHeadFile`.
 *
 * Test-gaming checks (live case 2026-11-06: the executor changed
 * `toBe(5)` → `toBe(6)` in a test and never touched the source, and the old
 * checks passed because the assertion count was unchanged):
 * - **Weakened expectations:** an existing assertion whose expected value,
 *   asserted expression, or matcher changed (or that was removed) is a
 *   violation unless the source file under test changed in the same diff
 *   (resolved through the test file's relative imports; when the test
 *   imports no repo source, any changed non-test file excuses it).
 * - **Test-only diff:** when every changed file is a test file, rewriting
 *   existing expectations without changing any source file is a violation —
 *   a fix must change source. Pure additions pass: a brand-new test file,
 *   or new assertions added to an existing test file without touching the
 *   old ones. Deliberate limit: changing an existing expectation is never
 *   acceptable from the daemon, even for a "fix the test itself" task —
 *   that is human work, because no check can tell a corrected expectation
 *   from a weakened one.
 */
function isTypeScriptProject(root: string): boolean {
  if (existsSync(join(root, 'tsconfig.json'))) return true;
  if (existsSync(join(root, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) return true;
    } catch {
      // ignore
    }
  }
  return (
    listFilesRecursive(join(root, 'src'), ['.ts', '.tsx']).length > 0 ||
    listFilesRecursive(join(root, 'test'), ['.ts', '.tsx']).length > 0
  );
}

export function checkDiffHygiene(input: DiffHygieneInput): DiffHygieneResult {
  const violations: string[] = [];

  for (const file of input.changedFiles) {
    const hit = matchesAny(file, SAFETY_DENYLIST);
    if (hit) violations.push(`forbidden path touched: ${file} (matches ${hit})`);
  }

  const secrets = scanPatchForSecrets(input.diff);
  for (const f of secrets.findings) {
    violations.push(`secret in ${f.file}:${f.line} — ${f.reason}`);
  }

  if (input.recentBlobHistory?.length && input.blobShas) {
    const history = new Set(input.recentBlobHistory);
    for (const [file, sha] of input.blobShas) {
      if (history.has(sha)) {
        violations.push(
          `oscillation: ${file} restores blob ${sha.slice(0, 12)} replaced by a recent autonomous task`,
        );
      }
    }
  }

  const changedTestFiles = input.changedFiles.filter(isTestFilePath);
  const changedSourceFiles = input.changedFiles.filter((f) => !isTestFilePath(f));
  const changedSourceModules = new Set(changedSourceFiles.map(normalizeModulePath));
  let assertionCount = 0;
  for (const file of changedTestFiles) {
    const content = input.readFile?.(file);
    if (content === undefined) continue;
    const analysis = analyzeSourceText(content, file);
    assertionCount += analysis.assertionCount;
    if (analysis.hasSkipOrOnly) {
      violations.push(`added .skip/.only (or xdescribe/xit/fit) in ${file}`);
    }
  }
  if (input.baselineAssertionCount !== undefined && assertionCount < input.baselineAssertionCount) {
    violations.push(
      `assertion count in changed tests fell ${input.baselineAssertionCount} → ${assertionCount}`,
    );
  }

  // Weakened expectations + test-only diff (needs HEAD content to compare).
  if (input.readHeadFile) {
    let weakenedCount = 0;
    for (const file of changedTestFiles) {
      const head = input.readHeadFile(file);
      const current = input.readFile?.(file);
      if (head === undefined || current === undefined) continue; // new file or unreadable
      const changed = findChangedAssertions(head, current, file);
      if (changed.length === 0) continue;
      // The source file(s) under test: the test's relative imports, from both
      // versions (a removed import must not hide the link). No resolvable
      // import → any changed non-test file excuses the change.
      const imports = new Set<string>();
      for (const text of [head, current]) {
        for (const spec of analyzeSourceText(text, file).relativeImports) {
          const resolved = resolveTestImport(file, spec);
          if (resolved !== null) imports.add(resolved);
        }
      }
      const sourceUnderTestChanged =
        imports.size > 0
          ? [...imports].some((imp) => changedSourceModules.has(imp))
          : changedSourceFiles.length > 0;
      if (sourceUnderTestChanged) continue;
      weakenedCount += changed.length;
      for (const c of changed) {
        violations.push(
          c.after === null
            ? `removed test expectation in ${file}: "${c.testTitle}" ${c.matcher} expected ${c.before} — test expectations must not be removed without changing the source under test`
            : `weakened test expectation in ${file}: "${c.testTitle}" ${c.matcher} expected ${c.before} → ${c.after} with no change to the source under test`,
        );
      }
    }
    const testOnly = input.changedFiles.length > 0 && input.changedFiles.every(isTestFilePath);
    if (testOnly && weakenedCount > 0) {
      violations.push(
        `test-only diff rewrites ${weakenedCount} existing test expectation(s) without changing any source file — a fix must change source (adding new tests is allowed; changing existing expectations is not)`,
      );
    }
  }

  return { clean: violations.length === 0, violations, assertionCount, changedTestFiles };
}

// ---------------------------------------------------------------------------
// Stage 4 — Adversarial critic
// ---------------------------------------------------------------------------

export interface CriticInput {
  task: VerificationTask;
  /** CLAUDE.md rules (or equivalent repo rules) given to the critic. */
  rules: string;
  diff: string;
}

const criticGradeSchema = z.object({
  logic_soundness: z.number().int().min(1).max(5),
  minimal_diff: z.number().int().min(1).max(5),
  convention_compliance: z.number().int().min(1).max(5),
  unintended_side_effects: z.number().int().min(1).max(5),
  verdict: z.enum(['APPROVE', 'REJECT']),
  notes: z.string().max(2000).optional(),
});

export type CriticGrade = z.infer<typeof criticGradeSchema>;
export type CriticFn = (input: CriticInput) => Promise<unknown>;

export const CRITIC_SYSTEM = `You are an adversarial reviewer with zero history of this change. You get only the task finding, the repo rules, and the diff. Grade strictly: a 5 means you would defend this line in review, a 3 means it works but you would ask for changes, a 1 means it is wrong. Score each dimension 1-5 and give verdict APPROVE only when every dimension is >= 4. REJECT any diff that changes test expectations (the expected value in expect(...).toBe/toEqual/toStrictEqual, or the asserted expression) without a corresponding fix in the source file under test: a test-only diff that rewrites expectations is gaming the tests, not fixing the bug. Reply with only a JSON object: {"logic_soundness": n, "minimal_diff": n, "convention_compliance": n, "unintended_side_effects": n, "verdict": "APPROVE" | "REJECT", "notes": "..."}.`;

export function gradeCritic(raw: unknown): CriticGrade | undefined {
  const parsed = criticGradeSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const g = parsed.data;
  const allFour =
    g.logic_soundness >= 4 &&
    g.minimal_diff >= 4 &&
    g.convention_compliance >= 4 &&
    g.unintended_side_effects >= 4;
  if (g.verdict === 'APPROVE' && !allFour) return undefined;
  return g;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface VerificationOptions {
  /** Health baseline captured before IMPLEMENT (enables the ratchet gate). */
  baselineHealth?: RepoHealthVector;
  /** Blob SHAs replaced by recent autonomous tasks (oscillation check). */
  recentBlobHistory?: readonly string[];
  /** Test ids already quarantined as flakes — excluded from the blocking gate. */
  quarantinedFlakes?: ReadonlySet<string>;
  /** Fresh zero-history critic. When omitted, Stage 4 is skipped (not blocking). */
  criticFn?: CriticFn;
  /** 0-based repair round the daemon is verifying (max 2 rounds → then FAIL). */
  repairRound?: number;
  /** Repo rules for the critic; defaults to CLAUDE.md in the worktree. */
  claudeMdRules?: string;
  /** Force Stage 3 on/off. Default: on for test_runner / self_review / coverage_gap. */
  runStage3?: boolean;
  /** Command runner (injectable for tests). */
  runCommand?: RunCommand;
  timeouts?: {
    staticMs?: number;
    relatedMs?: number;
    suiteMs?: number;
    revertProofMs?: number;
  };
}

export const MAX_REPAIR_ROUNDS = 2;

interface WorktreeDiff {
  files: string[];
  /** Map of file → 'A' (added) | 'M' (modified) | 'D' (deleted). */
  status: Map<string, string>;
  diff: string;
  linesAdded: number;
  linesDeleted: number;
}

interface VitestReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: {
    name?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string }[];
  }[];
}

interface CoverageSummary {
  total?: { lines?: { pct?: number }; branches?: { pct?: number } };
}

export class VerificationPipeline {
  private readonly runCommand: RunCommand;

  constructor(opts: { runCommand?: RunCommand } = {}) {
    this.runCommand = opts.runCommand ?? defaultRunCommand;
  }

  /** Run all 5 stages and return the daemon's ship / repair / quarantine verdict. */
  async verify(
    task: VerificationTask,
    worktreePath: string,
    options: VerificationOptions = {},
  ): Promise<VerificationResult> {
    const root = resolve(worktreePath);
    const repairRound = options.repairRound ?? 0;
    const stages: StageResult[] = [];
    const diagnostics: string[] = [];
    let netLoc = 0;
    let bloatNeedsHumanReview = false;

    const diff = await this.collectDiff(root);
    netLoc = diff.linesAdded - diff.linesDeleted;
    const bloat = checkBloat(diff.linesAdded, diff.linesDeleted, task.kind === 'coverage_gap');
    bloatNeedsHumanReview = bloat.needsHumanReview;
    if (bloat.needsHumanReview) {
      diagnostics.push(
        `net-LoC bloat: +${bloat.netLoc} lines exceeds ${BLOAT_NET_LOC_CAP} cap — human review required`,
      );
    }

    const failImmediately = (health?: RepoHealthVector): VerificationResult => ({
      outcome: 'FAIL',
      repairRound,
      stages,
      diagnostics,
      health,
      bloatNeedsHumanReview,
      netLoc,
    });

    // -- Stage 0: Diff Hygiene -------------------------------------------
    const stage0 = await this.runStage0(root, diff, options);
    stages.push(stage0);
    if (stage0.status === 'fail') {
      diagnostics.push(...stage0.diagnostics);
      return failImmediately(); // safety violations quarantine, never repair-loop
    }

    // -- Stage 1: Static & Type ------------------------------------------
    const stage1 = await this.runStage1(root, diff, options);
    stages.push(stage1);
    if (stage1.status === 'fail') {
      diagnostics.push(...stage1.diagnostics);
      return this.finishRepairOrFail(
        stages,
        diagnostics,
        repairRound,
        undefined, // no health vector yet — Stage 2 hasn't run
        bloatNeedsHumanReview,
        netLoc,
      );
    }

    // -- Stage 2: Tests ----------------------------------------------------
    const stage2 = await this.runStage2(root, diff, task, options, stage1.metrics);
    stages.push(stage2);
    const health = stage2.health;
    if (stage2.status === 'fail') {
      diagnostics.push(...stage2.diagnostics);
      return this.finishRepairOrFail(
        stages,
        diagnostics,
        repairRound,
        health,
        bloatNeedsHumanReview,
        netLoc,
      );
    }

    // Ratchet gate on the measured vector (Stage 2 produced it).
    if (options.baselineHealth && health) {
      const ratchet = assertNonDegradationPure(options.baselineHealth, health);
      if (!ratchet.ok) {
        const messages = ratchet.violations.map((v) => v.message);
        stages.push({
          stage: 2,
          name: 'Quality ratchet',
          status: 'fail',
          durationMs: 0,
          details: messages.join('; '),
          diagnostics: messages,
        });
        diagnostics.push(...messages);
        return this.finishRepairOrFail(
          stages,
          diagnostics,
          repairRound,
          health,
          bloatNeedsHumanReview,
          netLoc,
        );
      }
    }

    // -- Stage 3: Revert-Test Proof ----------------------------------------
    const wantStage3 =
      options.runStage3 ?? ['test_runner', 'self_review', 'coverage_gap'].includes(task.kind);
    if (wantStage3) {
      const stage3 = await this.runStage3(root, diff);
      stages.push(stage3);
      if (stage3.status === 'fail') {
        diagnostics.push(...stage3.diagnostics);
        return this.finishRepairOrFail(
          stages,
          diagnostics,
          repairRound,
          health,
          bloatNeedsHumanReview,
          netLoc,
        );
      }
    } else {
      stages.push({
        stage: 3,
        name: 'Revert-Test Proof',
        status: 'skipped',
        durationMs: 0,
        details: `not applicable to kind ${task.kind}`,
        diagnostics: [],
      });
    }

    // -- Stage 4: Adversarial Critic ---------------------------------------
    const stage4 = await this.runStage4(root, task, diff, options);
    stages.push(stage4);
    if (stage4.status === 'fail') {
      diagnostics.push(...stage4.diagnostics);
      return this.finishRepairOrFail(
        stages,
        diagnostics,
        repairRound,
        health,
        bloatNeedsHumanReview,
        netLoc,
      );
    }

    return {
      outcome: 'PASS',
      repairRound,
      stages,
      diagnostics,
      health,
      bloatNeedsHumanReview,
      netLoc,
    };
  }

  private finishRepairOrFail(
    stages: StageResult[],
    diagnostics: string[],
    repairRound: number,
    health: RepoHealthVector | undefined,
    bloatNeedsHumanReview: boolean,
    netLoc: number,
  ): VerificationResult {
    return {
      outcome: repairRound >= MAX_REPAIR_ROUNDS ? 'FAIL' : 'REPAIR',
      repairRound,
      stages,
      diagnostics,
      health,
      bloatNeedsHumanReview,
      netLoc,
    };
  }

  // -- Diff collection ------------------------------------------------------

  /** Tracked diff vs HEAD plus synthetic unified diffs for untracked files. */
  async collectDiff(worktreePath: string): Promise<WorktreeDiff> {
    const root = resolve(worktreePath);
    const status = new Map<string, string>();
    const nameStatus = await git(root, ['diff', 'HEAD', '--name-status'], { allowFailure: true });
    for (const line of nameStatus.stdout.split('\n')) {
      const [code, file] = line.split('\t');
      if (code && file) status.set(file, code.slice(0, 1));
    }
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard'], {
      allowFailure: true,
    });
    const files: string[] = [...status.keys()];
    let diff = '';
    const tracked = await git(root, ['diff', 'HEAD'], { allowFailure: true });
    diff += tracked.stdout;
    for (const file of untracked.stdout.split('\n').filter(Boolean)) {
      status.set(file, 'A');
      files.push(file);
      try {
        const content = await readFile(join(root, file), 'utf8');
        diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
        for (const line of content.split('\n')) diff += `+${line}\n`;
      } catch {
        // Unreadable untracked file (binary, deleted mid-run): skip its content.
      }
    }
    const numstat = await git(root, ['diff', 'HEAD', '--numstat'], { allowFailure: true });
    let linesAdded = 0;
    let linesDeleted = 0;
    for (const line of numstat.stdout.split('\n')) {
      const [added, deleted] = line.split('\t');
      linesAdded += Number.parseInt(added ?? '0', 10) || 0;
      linesDeleted += Number.parseInt(deleted ?? '0', 10) || 0;
    }
    // Untracked files count toward the bloat cap too.
    for (const file of untracked.stdout.split('\n').filter(Boolean)) {
      try {
        linesAdded += (await readFile(join(root, file), 'utf8')).split('\n').length;
      } catch {
        // ignore
      }
    }
    return { files, status, diff, linesAdded, linesDeleted };
  }

  // -- Stage 0 --------------------------------------------------------------

  async runStage0(
    worktreePath: string,
    diff: WorktreeDiff,
    options: VerificationOptions,
  ): Promise<StageResult> {
    const started = Date.now();
    const root = resolve(worktreePath);
    const diagnostics: string[] = [];

    // Baseline assertion count from the HEAD versions of the changed test files.
    let baselineAssertionCount: number | undefined;
    const headContents = new Map<string, string>();
    const testFiles = diff.files.filter(isTestFilePath);
    if (testFiles.length) {
      let baseline = 0;
      let sawHeadVersion = false;
      for (const file of testFiles) {
        const head = await git(root, ['show', `HEAD:${file}`], { allowFailure: true });
        if (head.exitCode === 0) {
          sawHeadVersion = true;
          baseline += analyzeSourceText(head.stdout, file).assertionCount;
          headContents.set(file, head.stdout);
        }
      }
      if (sawHeadVersion) baselineAssertionCount = baseline;
    }

    // Current blob SHAs for the oscillation check.
    const blobShas = new Map<string, string>();
    if (options.recentBlobHistory?.length) {
      for (const file of diff.files) {
        const hash = await git(root, ['hash-object', file], { allowFailure: true });
        if (hash.exitCode === 0 && hash.stdout.trim()) blobShas.set(file, hash.stdout.trim());
      }
    }

    const hygiene = checkDiffHygiene({
      diff: diff.diff,
      changedFiles: diff.files,
      blobShas,
      recentBlobHistory: options.recentBlobHistory,
      baselineAssertionCount,
      readFile: (relPath) => {
        try {
          return readFileSync(join(root, relPath), 'utf8');
        } catch {
          return undefined;
        }
      },
      readHeadFile: (relPath) => headContents.get(relPath),
    });
    diagnostics.push(...hygiene.violations);
    return {
      stage: 0,
      name: 'Diff Hygiene',
      status: hygiene.clean ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      details: hygiene.clean
        ? `${diff.files.length} files, ${hygiene.assertionCount} assertions in changed tests, no violations`
        : `${hygiene.violations.length} violation(s)`,
      diagnostics,
    };
  }

  // -- Stage 1 --------------------------------------------------------------

  async runStage1(
    worktreePath: string,
    diff: WorktreeDiff,
    options: VerificationOptions,
  ): Promise<StageResult> {
    const started = Date.now();
    const root = resolve(worktreePath);
    const diagnostics: string[] = [];
    const timeoutMs = options.timeouts?.staticMs ?? 120_000;

    const hasTs = isTypeScriptProject(root);
    let tscErrors: string[] = [];
    if (hasTs) {
      const tsc = await this.runCommand('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
        cwd: root,
        timeoutMs,
      });
      tscErrors = `${tsc.stdout}\n${tsc.stderr}`
        .split('\n')
        .filter((l) => /error TS\d+/.test(l));
      if (tsc.exitCode !== 0 || tsc.timedOut) {
        diagnostics.push(
          `tsc failed (exit ${tsc.exitCode}${tsc.timedOut ? ', timed out' : ''}): ${tscErrors.slice(0, 5).join(' | ') || 'no error lines captured'}`,
        );
      }
    }

    // ESLint on changed files only (fast) — unless a baseline is present, in
    // which case the ratchet needs repo-wide counts, so lint the whole repo.
    let lintErrors = 0;
    let lintWarnings = 0;
    let lintSkipped = false;
    const lintTargets = options.baselineHealth
      ? ['.']
      : diff.files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && existsSync(join(root, f)));
    if (lintTargets.length) {
      const eslint = await this.runCommand('npx', ['eslint', '--format', 'json', ...lintTargets], {
        cwd: root,
        timeoutMs,
      });
      try {
        const parsed: { errorCount?: number; warningCount?: number }[] = JSON.parse(
          eslint.stdout,
        ) as { errorCount?: number; warningCount?: number }[];
        for (const file of parsed) {
          lintErrors += file.errorCount ?? 0;
          lintWarnings += file.warningCount ?? 0;
        }
      } catch {
        // No working eslint setup in this repo (missing config, missing
        // binary, npx noise): skip the lint gate, don't fail the stage.
        // A skip is not a code defect — the executor cannot fix it, and
        // treating it as a failure burns both repair rounds on every task
        // before quarantining (found live 2026-11-06: an eslint-less repo
        // could never ship). Same posture as knip below.
        lintSkipped = true;
      }
      if (lintErrors > 0) diagnostics.push(`${lintErrors} eslint error(s) on changed files`);
      const baselineWarnings = options.baselineHealth?.lintWarningCount;
      if (baselineWarnings !== undefined && lintWarnings > baselineWarnings) {
        diagnostics.push(
          `eslint warnings on changed files (${lintWarnings}) exceed baseline (${baselineWarnings})`,
        );
      }
    }

    // Knip unused-export delta — skip gracefully when knip is absent.
    let knipNote = 'knip absent — skipped';
    const knipVersion = await this.runCommand('npx', ['--no-install', 'knip', '--version'], {
      cwd: root,
      timeoutMs: 30_000,
    });
    if (knipVersion.exitCode === 0) {
      const knip = await this.runCommand(
        'npx',
        ['--no-install', 'knip', '--no-progress', '--reporter', 'json'],
        { cwd: root, timeoutMs },
      );
      try {
        const parsed = JSON.parse(knip.stdout) as { files?: unknown; exports?: unknown };
        const unused =
          (Array.isArray(parsed.files) ? parsed.files.length : 0) +
          (Array.isArray(parsed.exports) ? parsed.exports.length : 0);
        knipNote = `knip: ${unused} unused export(s)/file(s)`;
      } catch {
        knipNote = 'knip output unparsable — skipped';
      }
    }

    const failed = diagnostics.length > 0;
    return {
      stage: 1,
      name: 'Static & Type',
      status: failed ? 'fail' : 'pass',
      durationMs: Date.now() - started,
      details: `tsc errors: ${tscErrors.length}, eslint errors: ${lintErrors}, warnings: ${lintWarnings}${lintSkipped ? ' (lint skipped)' : ''}; ${knipNote}`,
      diagnostics,
      metrics: { lintErrors, lintWarnings },
    };
  }

  // -- Stage 2 --------------------------------------------------------------

  async runStage2(
    worktreePath: string,
    diff: WorktreeDiff,
    task: VerificationTask,
    options: VerificationOptions,
    priorLint?: { lintErrors?: number; lintWarnings?: number },
  ): Promise<StageResult & { health?: RepoHealthVector }> {
    const started = Date.now();
    const root = resolve(worktreePath);
    const diagnostics: string[] = [];
    const timeoutMs = options.timeouts?.suiteMs ?? 900_000;
    const quarantined = options.quarantinedFlakes ?? new Set<string>();

    // Related tests first: the test files the task touched.
    const touchedTests = diff.files.filter(
      (f) => (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) && existsSync(join(root, f)),
    );
    if (touchedTests.length) {
      const related = await this.runCommand('npx', ['vitest', 'run', ...touchedTests], {
        cwd: root,
        timeoutMs: options.timeouts?.relatedMs ?? 300_000,
      });
      if (related.exitCode !== 0) {
        diagnostics.push(`related tests failed (exit ${related.exitCode}) for ${task.id}`);
        return {
          stage: 2,
          name: 'Tests',
          status: 'fail',
          durationMs: Date.now() - started,
          details: 'related test run failed',
          diagnostics,
        };
      }
    }

    // Full suite with coverage; JSON report to a temp file for counts.
    const tmpDir = await mkdtemp(join(tmpdir(), 'omnexx-verify-'));
    const reportPath = join(tmpDir, 'vitest.json');
    const suite = await this.runCommand(
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

    let report: VitestReport = {};
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as VitestReport;
    } catch {
      diagnostics.push('vitest JSON report missing/unparsable — full suite result unknown');
    }
    const failedIds: string[] = [];
    for (const fileResult of report.testResults ?? []) {
      for (const assertion of fileResult.assertionResults ?? []) {
        if (assertion.status === 'failed') {
          failedIds.push(
            `${fileResult.name ?? ''} › ${assertion.fullName ?? assertion.title ?? ''}`,
          );
        }
      }
    }
    const blockingFailures = failedIds.filter(
      (id) => ![...quarantined].some((q) => id.includes(q)),
    );
    const excludedCount = failedIds.length - blockingFailures.length;

    let lineCoveragePct = 0;
    let branchCoveragePct = 0;
    try {
      const summary = JSON.parse(
        await readFile(join(root, 'coverage', 'coverage-summary.json'), 'utf8'),
      ) as CoverageSummary;
      lineCoveragePct = summary.total?.lines?.pct ?? 0;
      branchCoveragePct = summary.total?.branches?.pct ?? 0;
    } catch {
      // No coverage summary (e.g. suite crashed before coverage wrote out).
    }

    // Health vector for the ratchet gate. Test/coverage/duration come from
    // this suite run; tsc is re-measured repo-wide; assertion count and
    // complexity are repo-wide AST scans (cheap — no test run); lint counts
    // come from Stage 1, which lints repo-wide whenever a baseline exists.
    let tscErrorCount = 0;
    if (isTypeScriptProject(root)) {
      const tsc = await this.runCommand('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
        cwd: root,
        timeoutMs: 120_000,
      });
      tscErrorCount = `${tsc.stdout}\n${tsc.stderr}`
        .split('\n')
        .filter((l) => /error TS\d+/.test(l)).length;
    }
    const allTestFiles = [
      ...listFilesRecursive(join(root, 'test'), ['.test.ts', '.test.tsx']),
      ...listFilesRecursive(join(root, 'src'), ['.test.ts', '.test.tsx']),
    ];
    const allSrcFiles = listFilesRecursive(join(root, 'src'), ['.ts', '.tsx']).filter(
      (f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'),
    );
    const health: RepoHealthVector = {
      tscErrorCount,
      lintErrorCount: priorLint?.lintErrors ?? 0,
      lintWarningCount: priorLint?.lintWarnings ?? 0,
      passingTestCount: report.numPassedTests ?? 0,
      totalAssertionCount: countAssertionsInFiles(allTestFiles),
      lineCoveragePct,
      branchCoveragePct,
      maxCyclomaticComplexity: maxComplexityInFiles(allSrcFiles),
      testSuiteDurationMs: suite.durationMs,
    };

    // Touched-file complexity ratchet (spec: max complexity ≤ baseline across
    // touched files). The repo-wide vector above can't express this, so compare
    // the touched files against their own HEAD versions directly.
    const touchedSrc = diff.files.filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && existsSync(join(root, f)),
    );
    if (touchedSrc.length) {
      let headMax = 0;
      let sawHead = false;
      for (const file of touchedSrc) {
        const head = await git(root, ['show', `HEAD:${file}`], { allowFailure: true });
        if (head.exitCode === 0) {
          sawHead = true;
          headMax = Math.max(headMax, analyzeSourceText(head.stdout, file).maxCyclomaticComplexity);
        }
      }
      if (sawHead) {
        const currentMax = maxComplexityInFiles(touchedSrc.map((f) => join(root, f)));
        if (currentMax > headMax) {
          diagnostics.push(
            `max cyclomatic complexity in touched files rose ${headMax} → ${currentMax}`,
          );
        }
      }
    }

    if (suite.timedOut) diagnostics.push('full test suite timed out');
    if (suite.exitCode !== 0 && failedIds.length === 0) {
      diagnostics.push(
        `full test suite exited ${suite.exitCode} with no parseable test failures — see suite output`,
      );
    }
    if (blockingFailures.length) {
      diagnostics.push(
        `${blockingFailures.length} blocking test failure(s): ${blockingFailures.slice(0, 5).join(' | ')}`,
      );
    }
    if (options.baselineHealth) {
      if (lineCoveragePct < options.baselineHealth.lineCoveragePct - 0.01) {
        diagnostics.push(
          `line coverage fell ${options.baselineHealth.lineCoveragePct}% → ${lineCoveragePct}%`,
        );
      }
      if (branchCoveragePct < options.baselineHealth.branchCoveragePct - 0.01) {
        diagnostics.push(
          `branch coverage fell ${options.baselineHealth.branchCoveragePct}% → ${branchCoveragePct}%`,
        );
      }
    }

    const failed = diagnostics.length > 0;
    return {
      stage: 2,
      name: 'Tests',
      status: failed ? 'fail' : 'pass',
      durationMs: Date.now() - started,
      details:
        `passed ${report.numPassedTests ?? 0}/${report.numTotalTests ?? 0} tests` +
        (excludedCount ? `, ${excludedCount} quarantined flake(s) excluded` : '') +
        `, line ${lineCoveragePct}%, branch ${branchCoveragePct}%`,
      diagnostics,
      health,
    };
  }

  // -- Stage 3 --------------------------------------------------------------

  /**
   * Revert-Test Proof: stash src/** changes while keeping test/** changes,
   * run the new/modified tests — they MUST fail on unpatched src — then
   * restore the patch and confirm they pass. Proves the test isn't
   * tautological. File-level backup/restore (no `git stash`, so staged state
   * and untracked files are untouched).
   */
  async runStage3(worktreePath: string, diff: WorktreeDiff): Promise<StageResult> {
    const started = Date.now();
    const root = resolve(worktreePath);
    const diagnostics: string[] = [];

    const srcFiles = diff.files.filter(
      (f) =>
        (f.startsWith('src/') || f.startsWith('test/')) &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx'),
    );
    const testFiles = diff.files.filter(isTestFilePath);
    if (!testFiles.length) {
      return {
        stage: 3,
        name: 'Revert-Test Proof',
        status: 'skipped',
        durationMs: Date.now() - started,
        details: 'no new/modified tests to prove',
        diagnostics,
      };
    }
    if (!srcFiles.length) {
      // No src change to revert against — but that alone is not a pass: a
      // test-only diff that REWRITES existing expectations (the 2026-11-06
      // live case: toBe(5) → toBe(6), src untouched) has nothing to prove
      // and must fail here as well as in Stage 0. A test-only diff that
      // only ADDS tests (new files, or new assertions in an existing file)
      // still skips: there is nothing to revert-prove and nothing weakened.
      const rewritten: string[] = [];
      for (const file of testFiles) {
        if (diff.status.get(file) === 'A') continue; // new test file: pure addition
        const head = await git(root, ['show', `HEAD:${file}`], { allowFailure: true });
        if (head.exitCode !== 0) continue;
        let current: string;
        try {
          current = await readFile(join(root, file), 'utf8');
        } catch {
          continue;
        }
        const changed = findChangedAssertions(head.stdout, current, file);
        if (changed.length > 0)
          rewritten.push(`${file} (${changed.length} changed expectation(s))`);
      }
      if (rewritten.length > 0) {
        diagnostics.push(
          `revert-test proof FAILED: ${rewritten.join(', ')} change test expectations without any source change — there is no src patch to revert against, so the tests prove nothing; test expectations must not change unless the source under test changes too`,
        );
        return {
          stage: 3,
          name: 'Revert-Test Proof',
          status: 'fail',
          durationMs: Date.now() - started,
          details: 'test-only diff rewrites existing expectations with no src change',
          diagnostics,
        };
      }
      return {
        stage: 3,
        name: 'Revert-Test Proof',
        status: 'skipped',
        durationMs: Date.now() - started,
        details: 'no src changes to revert against',
        diagnostics,
      };
    }

    const backupDir = await mkdtemp(join(tmpdir(), 'omnexx-revert-proof-'));
    try {
      // Back up current src files, then revert them to HEAD (delete added ones).
      for (const file of srcFiles) {
        const abs = join(root, file);
        if (!existsSync(abs)) continue;
        const backup = join(backupDir, file);
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(abs, backup);
      }
      for (const file of srcFiles) {
        if (diff.status.get(file) === 'A') {
          await rm(join(root, file), { force: true });
        } else {
          await git(root, ['checkout', 'HEAD', '--', file], { allowFailure: true });
        }
      }

      const unpatched = await this.runCommand('npx', ['vitest', 'run', ...testFiles], {
        cwd: root,
        timeoutMs: 300_000,
      });
      if (unpatched.exitCode === 0) {
        diagnostics.push(
          `revert-test proof FAILED: new/modified tests pass on unpatched src — they are tautological (${testFiles.join(', ')})`,
        );
        return {
          stage: 3,
          name: 'Revert-Test Proof',
          status: 'fail',
          durationMs: Date.now() - started,
          details: 'tests pass without the src patch',
          diagnostics,
        };
      }

      // Restore the patch and confirm the tests pass with it.
      for (const file of srcFiles) {
        const backup = join(backupDir, file);
        if (!existsSync(backup)) continue;
        await copyFile(backup, join(root, file));
      }
      const patched = await this.runCommand('npx', ['vitest', 'run', ...testFiles], {
        cwd: root,
        timeoutMs: 300_000,
      });
      if (patched.exitCode !== 0) {
        diagnostics.push(`tests fail even with the src patch applied (exit ${patched.exitCode})`);
        return {
          stage: 3,
          name: 'Revert-Test Proof',
          status: 'fail',
          durationMs: Date.now() - started,
          details: 'tests fail with patch applied',
          diagnostics,
        };
      }
      return {
        stage: 3,
        name: 'Revert-Test Proof',
        status: 'pass',
        durationMs: Date.now() - started,
        details: `tests fail on unpatched src and pass with the patch (${testFiles.length} file(s))`,
        diagnostics,
      };
    } finally {
      // Never leave the worktree reverted, even when the proof itself errors.
      for (const file of srcFiles) {
        const backup = join(backupDir, file);
        if (existsSync(backup) && !existsSync(join(root, file))) {
          await copyFile(backup, join(root, file)).catch(() => undefined);
        }
      }
      await rm(backupDir, { recursive: true, force: true });
    }
  }

  // -- Stage 4 --------------------------------------------------------------

  async runStage4(
    worktreePath: string,
    task: VerificationTask,
    diff: WorktreeDiff,
    options: VerificationOptions,
  ): Promise<StageResult> {
    const started = Date.now();
    const root = resolve(worktreePath);
    if (!options.criticFn) {
      return {
        stage: 4,
        name: 'Adversarial Critic',
        status: 'skipped',
        durationMs: Date.now() - started,
        details: 'no criticFn configured — stage skipped, not blocking',
        diagnostics: [],
      };
    }
    let rules = options.claudeMdRules ?? '';
    if (!rules) {
      try {
        rules = await readFile(join(root, 'CLAUDE.md'), 'utf8');
      } catch {
        rules = '';
      }
    }
    const clipped = clipDiff(diff.diff, 30_000);
    const raw = await options.criticFn({
      task,
      rules,
      diff: clipped,
    });
    const grade = gradeCritic(raw);
    if (!grade) {
      return {
        stage: 4,
        name: 'Adversarial Critic',
        status: 'fail',
        durationMs: Date.now() - started,
        details: 'critic returned an unusable grade (malformed JSON or APPROVE with a sub-4 score)',
        diagnostics: ['critic grade unusable — treat as REJECT'],
      };
    }
    const approved = grade.verdict === 'APPROVE';
    return {
      stage: 4,
      name: 'Adversarial Critic',
      status: approved ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      details: `logic ${grade.logic_soundness}/5, minimal ${grade.minimal_diff}/5, conventions ${grade.convention_compliance}/5, side-effects ${grade.unintended_side_effects}/5 → ${grade.verdict}${grade.notes ? ` — ${grade.notes}` : ''}`,
      diagnostics: approved
        ? []
        : [`critic verdict ${grade.verdict}: ${grade.notes ?? 'no notes'}`],
    };
  }
}

/** Deterministic fingerprint of a diff, for tombstones / oscillation history. */
export function diffFingerprint(diff: string): string {
  return createHash('sha256').update(diff).digest('hex');
}
