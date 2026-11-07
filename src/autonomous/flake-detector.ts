import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { git } from '../git/git.js';
import { collectRelativeImports, defaultRunCommand, type RunCommand } from './ast-analysis.js';

/**
 * FlakeIsolationController — when Stage 2 fails on a test T the current task
 * did not target, decide whether T is a pre-existing flake or a real
 * regression by re-running it 3× in isolation on a clean base-HEAD worktree.
 *
 * - Fails ≥1/3 on clean HEAD → pre-existing flake: recorded in the flaky_tests
 *   table (via the injected store), excluded from the blocking gate, and a
 *   high-priority flake_remediation task is enqueued (severity 1.0, score 92.0).
 * - Passes 3/3 on clean HEAD → real regression: the failure stands.
 *
 * The flaky_tests table itself belongs to the daemon's state store; this
 * module only defines the `FlakeStore` interface it writes through.
 */

export const FLAKE_ISOLATION_RUNS = 3;
export const FLAKE_REMEDIATION_SEVERITY = 1.0;
export const FLAKE_REMEDIATION_SCORE = 92.0;

export interface RecordedFlake {
  testId: string;
  file: string;
  name: string;
  firstSeenAt: string;
  failuresOnCleanHead: number;
  runsOnCleanHead: number;
  baseHead: string;
}

/** Minimal interface over the daemon's flaky_tests table. */
export interface FlakeStore {
  record(flake: RecordedFlake): Promise<void> | void;
  isKnown?(testId: string): Promise<boolean> | boolean;
}

export type FlakeVerdict = 'pre-existing-flake' | 'real-regression';

export interface FlakeEnqueue {
  kind: 'flake_remediation';
  severity: 1.0;
  score: 92.0;
  testId: string;
  file: string;
  name: string;
}

export interface FlakeInvestigationResult {
  verdict: FlakeVerdict;
  testId: string;
  cleanHeadRuns: { passed: number; failed: number };
  /** Set when the test was confirmed a pre-existing flake. */
  recorded?: RecordedFlake;
  /** High-priority remediation task for the daemon's queue. */
  enqueue?: FlakeEnqueue;
  /** True when the daemon may exclude this test from the blocking gate. */
  excludedFromGate: boolean;
  details: string;
}

export interface FlakeInvestigationOptions {
  /** Test file, repo-relative (e.g. `test/unit/verify/ratchet.test.ts`). */
  file: string;
  /** Test name as passed to `vitest -t` (e.g. `rejects any new failure`). */
  name: string;
  /** Worktree where the task ran (used for the relatedness check). */
  worktreePath: string;
  /** Base commit the task branched from — the clean HEAD for isolation runs. */
  baseHead: string;
  /** Repo-relative files the current task touched. */
  taskTouchedFiles: readonly string[];
  /** Clean worktree already checked out at baseHead. Created (and removed)
   *  in a temp dir when omitted. */
  cleanWorktreePath?: string;
  store?: FlakeStore;
  runCommand?: RunCommand;
  timeoutMs?: number;
}

/** Test id as the daemon / Stage 2 report it: `file › name`. */
export function testIdFor(file: string, name: string): string {
  return `${file} › ${name}`;
}

/**
 * Is test file T targeted by the current task? True when T itself was touched,
 * or when T imports (one level) a file the task touched. Everything else is
 * "unrelated" and eligible for flake isolation. `testFile` is repo-relative;
 * `worktreeRoot` locates it on disk for the import-graph read.
 */
export function isTestRelatedToTask(
  testFile: string,
  taskTouchedFiles: readonly string[],
  worktreeRoot: string,
): boolean {
  const touched = new Set(taskTouchedFiles.map((f) => f.replace(/\\/g, '/')));
  const normalized = testFile.replace(/\\/g, '/');
  if (touched.has(normalized)) return true;
  const abs = join(resolve(worktreeRoot), normalized);
  const imports = collectRelativeImports(abs);
  const dir = dirname(abs);
  for (const spec of imports) {
    const base = resolve(dir, spec);
    // ESM-style imports name the compiled file (`./foo.js` for `foo.ts`).
    const candidates = [
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    ];
    if (base.endsWith('.js')) {
      candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
    }
    for (const candidate of candidates) {
      const rel = candidate.replace(/\\/g, '/');
      // Match on trailing path segments: the candidate is absolute, the
      // touched list is repo-relative.
      for (const t of touched) {
        if (rel.endsWith(`/${t}`) || rel === t) return true;
      }
    }
  }
  return false;
}

export class FlakeIsolationController {
  private readonly runCommand: RunCommand;

  constructor(opts: { runCommand?: RunCommand } = {}) {
    this.runCommand = opts.runCommand ?? defaultRunCommand;
  }

  /**
   * Investigate one Stage 2 failure. The caller has already established the
   * test is unrelated to the task (or passes `taskTouchedFiles` and lets this
   * method check); related failures are real regressions by definition and
   * are returned as such without isolation runs.
   */
  async investigate(opts: FlakeInvestigationOptions): Promise<FlakeInvestigationResult> {
    const testId = testIdFor(opts.file, opts.name);
    const root = resolve(opts.worktreePath);

    if (isTestRelatedToTask(opts.file, opts.taskTouchedFiles, root)) {
      return {
        verdict: 'real-regression',
        testId,
        cleanHeadRuns: { passed: 0, failed: 0 },
        excludedFromGate: false,
        details: `${testId} is targeted by the current task — no isolation runs, failure stands.`,
      };
    }

    let cleanWorktree = opts.cleanWorktreePath;
    let ownsWorktree = false;
    try {
      if (!cleanWorktree) {
        cleanWorktree = await mkdtemp(join(tmpdir(), 'omnexx-flake-'));
        // mkdtemp created the dir; git worktree add needs it absent.
        await rm(cleanWorktree, { recursive: true, force: true });
        const added = await git(
          root,
          ['worktree', 'add', '--detach', cleanWorktree, opts.baseHead],
          {
            allowFailure: true,
          },
        );
        if (added.exitCode !== 0) {
          return {
            verdict: 'real-regression',
            testId,
            cleanHeadRuns: { passed: 0, failed: 0 },
            excludedFromGate: false,
            details: `could not create clean worktree at ${opts.baseHead} — failing closed as a real regression`,
          };
        }
        ownsWorktree = true;
      }

      // The clean worktree needs dependencies to run vitest. A fresh
      // `git worktree add` has none — without this check every run would fail
      // and a real regression would be misclassified as a flake. Fail closed.
      if (!existsSync(join(resolve(cleanWorktree), 'node_modules', 'vitest'))) {
        return {
          verdict: 'real-regression',
          testId,
          cleanHeadRuns: { passed: 0, failed: 0 },
          excludedFromGate: false,
          details: `clean worktree at ${opts.baseHead.slice(0, 12)} has no node_modules/vitest — cannot isolate, failing closed as a real regression`,
        };
      }

      const testFileAbs = join(resolve(cleanWorktree), opts.file);
      if (!existsSync(testFileAbs)) {
        return {
          verdict: 'real-regression',
          testId,
          cleanHeadRuns: { passed: 0, failed: 0 },
          excludedFromGate: false,
          details: `${opts.file} does not exist at ${opts.baseHead} — failing closed as a real regression`,
        };
      }

      let passed = 0;
      let failed = 0;
      for (let i = 0; i < FLAKE_ISOLATION_RUNS; i++) {
        const run = await this.runCommand(
          'npx',
          ['vitest', 'run', opts.file, '-t', opts.name, '--retry=0'],
          { cwd: resolve(cleanWorktree), timeoutMs: opts.timeoutMs ?? 180_000 },
        );
        if (run.exitCode === 0) passed++;
        else failed++;
      }

      if (failed >= 1) {
        const recorded: RecordedFlake = {
          testId,
          file: opts.file,
          name: opts.name,
          firstSeenAt: new Date().toISOString(),
          failuresOnCleanHead: failed,
          runsOnCleanHead: FLAKE_ISOLATION_RUNS,
          baseHead: opts.baseHead,
        };
        await opts.store?.record(recorded);
        return {
          verdict: 'pre-existing-flake',
          testId,
          cleanHeadRuns: { passed, failed },
          recorded,
          enqueue: {
            kind: 'flake_remediation',
            severity: FLAKE_REMEDIATION_SEVERITY,
            score: FLAKE_REMEDIATION_SCORE,
            testId,
            file: opts.file,
            name: opts.name,
          },
          excludedFromGate: true,
          details: `${testId} failed ${failed}/${FLAKE_ISOLATION_RUNS} on clean HEAD ${opts.baseHead.slice(0, 12)} — pre-existing flake, excluded from the blocking gate.`,
        };
      }
      return {
        verdict: 'real-regression',
        testId,
        cleanHeadRuns: { passed, failed },
        excludedFromGate: false,
        details: `${testId} passed ${FLAKE_ISOLATION_RUNS}/${FLAKE_ISOLATION_RUNS} on clean HEAD — the task's change regressed it.`,
      };
    } finally {
      if (ownsWorktree && cleanWorktree) {
        await git(root, ['worktree', 'remove', '--force', cleanWorktree], {
          allowFailure: true,
        }).catch(() => undefined);
      }
    }
  }
}
