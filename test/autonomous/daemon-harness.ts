/**
 * Shared harness for the daemon soak and crash-resume tests.
 *
 * The real `AutonomousDaemon` now drives ONE task per cycle through
 * PLAN → IMPLEMENT → VERIFY → SHIP → LEARN against the real SQLite
 * `AutonomousStateStore`, the real `TriageEngine` (done-set / tombstone
 * dedupe, PriorityScore, churn guard) and the real `WorktreeManager`.
 * This harness supplies only the pieces with no sibling module:
 *
 * - `MockDiscovery` — a `DiscoveryOrchestrator`-shaped collector that
 *   reports the five fixture scenarios. `fix-adder` is reported only while
 *   `src/adder.ts` still contains the bug (a real test-runner collector
 *   would not report a passing test); the rest are reported every cycle
 *   and gated by the real triage (tombstones / done-set).
 * - `MockPlanner` — the Architect stub: a bounded plan per scenario.
 * - `MockTaskExecutor` — asks the `ScriptedMockLLMProvider` what to do,
 *   then carries the action out for real in the task worktree.
 * - `MockVerifier` — the real `VerificationPipeline` interface: runs the
 *   scenario's verification command in the worktree; the flaky scenario
 *   always FAILs (quarantined on clean HEAD).
 * - `MockShipper` — the real `ShippingController` interface: commits in
 *   the worktree and fast-forward-merges to main.
 *
 * Two deviations the tests work around (owned by other workers):
 * - The store takes no Clock: its timestamps are real `Date.now()` while
 *   triage's `now` is the injected FakeClock. The soak's simulated clock
 *   runs ahead of real time, so tombstone cooldowns expire sooner in
 *   simulated time than in production; the invariant both sides enforce
 *   (never retry while `cooldownUntilMs > now`) is the same.
 * - `WorktreeManager.create` is not idempotent: after a crash leaves a
 *   task worktree behind, the daemon's re-create fails. Crash-resume
 *   calls the real `pruneStale()` before the fresh boot (see
 *   crash-resume.test.ts); the daemon itself never prunes on boot.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AutonomousDaemon,
  type ArchitectPlanner,
  type DaemonLogger,
  type DaemonState,
  type TaskExecutionPlan,
  type TaskExecutor,
  type TurnResult,
} from '../../src/autonomous/daemon.js';
import {
  DiscoveryOrchestrator,
  type RawFinding as DiscoveryRawFinding,
} from '../../src/autonomous/discovery/index.js';
import { AutonomousStateStore, type QueuedTask } from '../../src/autonomous/state-store.js';
import {
  ShippingController,
  type ShipResult,
  type ShipTask,
} from '../../src/autonomous/shipping.js';
import { TriageEngine } from '../../src/autonomous/triage.js';
import { assertPathAllowed } from '../../src/autonomous/tool-guard.js';
import {
  VerificationPipeline,
  type VerificationResult,
  type VerificationTask,
} from '../../src/autonomous/verification-pipeline.js';
import { WorktreeManager } from '../../src/autonomous/worktree-manager.js';
import { git } from '../../src/git/git.js';
import type { Clock } from '../../src/core/clock.js';
import type { FakeClock } from './fake-clock.js';
import {
  buildMockRequest,
  SCENARIO_IDS,
  ScriptedMockLLMProvider,
  type ScenarioId,
} from './mock-llm.js';

/** The fixture scenarios, in discovery order (fix-adder first, so it ships first). */
export const SCENARIO_PLANS: Readonly<Record<ScenarioId, TaskExecutionPlan>> = {
  'fix-adder': {
    filesToTouch: ['src/adder.ts'],
    verificationCommand: 'node --test test/adder.test.ts',
    subSteps: ['fix add() to return a + b'],
    summary: 'Fix adder to return a + b',
  },
  'mode-oscillation': {
    filesToTouch: ['src/mode.ts'],
    verificationCommand: 'node --test test/mode-a.test.ts test/mode-b.test.ts',
    subSteps: ['set MODE so both mode tests pass'],
    summary: 'Make both mode tests pass',
  },
  'repeat-error': {
    filesToTouch: ['scripts/fail.mjs'],
    verificationCommand: 'node scripts/fail.mjs',
    subSteps: ['run the failing command until it passes'],
    summary: 'Fix the failing command',
  },
  'edit-ci': {
    filesToTouch: ['.github/workflows/ci.yml'],
    verificationCommand: 'node --test test/',
    subSteps: ['edit the CI workflow'],
    summary: 'Update the CI workflow',
  },
  'flaky-test': {
    filesToTouch: ['test/flaky.test.ts'],
    verificationCommand: 'node --test test/flaky.test.ts',
    subSteps: ['stabilise the flaky test'],
    summary: 'Quarantine or fix the flaky test',
  },
};

/** Discovery findings per scenario (collector `test-runner` → kind `failing-test`). */
export const SCENARIO_FINDINGS: Readonly<Record<ScenarioId, DiscoveryRawFinding>> = {
  'fix-adder': {
    collector: 'test-runner',
    ruleOrTestId: 'scenario:fix-adder',
    targetFiles: ['src/adder.ts'],
    severity: 0.8,
    confidence: 0.9,
    verification: 1.0,
    findingPayload: { scenario: 'fix-adder' },
  },
  'mode-oscillation': {
    collector: 'test-runner',
    ruleOrTestId: 'scenario:mode-oscillation',
    targetFiles: ['src/mode.ts'],
    severity: 0.8,
    confidence: 0.9,
    verification: 1.0,
    findingPayload: { scenario: 'mode-oscillation' },
  },
  'repeat-error': {
    collector: 'test-runner',
    ruleOrTestId: 'scenario:repeat-error',
    targetFiles: ['scripts/fail.mjs'],
    severity: 0.8,
    confidence: 0.9,
    verification: 1.0,
    findingPayload: { scenario: 'repeat-error' },
  },
  'edit-ci': {
    collector: 'test-runner',
    ruleOrTestId: 'scenario:edit-ci',
    targetFiles: ['.github/workflows/ci.yml'],
    severity: 0.8,
    confidence: 0.9,
    verification: 1.0,
    findingPayload: { scenario: 'edit-ci' },
  },
  'flaky-test': {
    collector: 'test-runner',
    ruleOrTestId: 'scenario:flaky-test',
    targetFiles: ['test/flaky.test.ts'],
    severity: 0.8,
    confidence: 0.9,
    verification: 1.0,
    findingPayload: { scenario: 'flaky-test' },
  },
};

/** Which scenario a queued task is, from its stored finding payload. */
export function scenarioOfTask(task: QueuedTask): ScenarioId {
  const payload = task.findingPayload as { ruleOrTestId?: unknown } | null;
  const id = typeof payload === 'object' && payload !== null ? payload.ruleOrTestId : undefined;
  if (typeof id === 'string') {
    for (const scenario of SCENARIO_IDS) {
      if (id === `scenario:${scenario}`) return scenario;
    }
  }
  throw new Error(`harness: unknown scenario for task ${task.taskId} (ruleOrTestId=${String(id)})`);
}

/** Outcomes the harness observes while the daemon runs (asserted after the run). */
export class HarnessOutcomes {
  readonly shipped: { title: string; commitSha: string }[] = [];
  readonly quarantined = new Map<string, { strikes: number; untilMs: number | undefined }>();
  readonly failed = new Set<string>();
  readonly planned: { title: string; fingerprint: string }[] = [];
  readonly titlesById = new Map<string, { title: string; fingerprint: string }>();
  readonly transitions: { from: DaemonState; to: DaemonState; taskId: string | undefined }[] = [];

  get doneTitles(): Set<string> {
    return new Set(this.shipped.map((s) => s.title));
  }
}

type HangPhase = 'plan' | 'implement' | 'verify';
export type HangPredicate = (phase: HangPhase, taskId: string) => boolean;

function runShell(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', command], { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? ((error as { code?: number }).code ?? -1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Working-tree hash after a turn. `git write-tree` hashes the INDEX, not
 * the working tree, so stage first — otherwise an unstaged edit is
 * invisible and two different working-tree states hash identically (which
 * made the mode-oscillation trap trip on turn 2 instead of turn 3).
 */
async function treeHashOf(workDir: string): Promise<string | undefined> {
  const add = await git(workDir, ['add', '-A'], { allowFailure: true });
  if (add.exitCode !== 0) return undefined;
  const result = await git(workDir, ['write-tree'], { allowFailure: true });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

const never = (): Promise<never> => new Promise(() => undefined);

/** Scripted discovery: the five scenarios, fix-adder only while the bug is present. */
class MockDiscovery extends DiscoveryOrchestrator {
  constructor(
    private readonly repoRoot: string,
    private readonly scenarios: readonly ScenarioId[],
    private readonly outcomes: HarnessOutcomes,
  ) {
    super([]);
  }

  override async collect(): Promise<{
    findings: DiscoveryRawFinding[];
    errors: Record<string, string>;
  }> {
    const findings: DiscoveryRawFinding[] = [];
    for (const id of this.scenarios) {
      // Stop re-offering resolved scenarios: once one is shipped,
      // permanently tombstoned, or failed, re-reporting it only re-runs the
      // real triage's git fingerprint per cycle without changing anything
      // (the queue row is gone or stuck in a non-QUEUED status). Cooldown
      // behaviour is exercised in full while strikes 1–4 are live.
      if (this.outcomes.doneTitles.has(id)) continue;
      if (this.outcomes.failed.has(id)) continue;
      const tomb = this.outcomes.quarantined.get(id);
      if (tomb !== undefined && tomb.untilMs === undefined) continue; // permanent
      if (id === 'fix-adder') {
        const adder = await readFile(join(this.repoRoot, 'src/adder.ts'), 'utf8').catch(() => '');
        if (!adder.includes('return a - b;')) continue;
      }
      findings.push({ ...SCENARIO_FINDINGS[id] });
    }
    return { findings, errors: {} };
  }
}

class MockPlanner implements ArchitectPlanner {
  constructor(
    private readonly outcomes: HarnessOutcomes,
    private readonly hang?: HangPredicate,
  ) {}

  async plan(task: QueuedTask): Promise<TaskExecutionPlan> {
    const scenario = scenarioOfTask(task);
    this.outcomes.titlesById.set(task.taskId, { title: scenario, fingerprint: task.fingerprint });
    this.outcomes.planned.push({ title: scenario, fingerprint: task.fingerprint });
    if (this.hang?.('plan', task.taskId)) return never();
    return { ...SCENARIO_PLANS[scenario] };
  }
}

class MockTaskExecutor implements TaskExecutor {
  constructor(
    private readonly repoRoot: string,
    private readonly provider: ScriptedMockLLMProvider,
    private readonly worktrees: WorktreeManager | undefined,
    private readonly outcomes: HarnessOutcomes,
    private readonly hang?: HangPredicate,
  ) {}

  private workDir(task: QueuedTask): string {
    if (this.worktrees) {
      const path = this.worktrees.pathFor(task.taskId);
      if (existsSync(path)) return path;
    }
    return this.repoRoot;
  }

  async executeTurn(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    turn: number,
    _signal: AbortSignal,
    onToolCall: (call: { toolName: string; inputSummary?: string }) => void | Promise<void>,
  ): Promise<TurnResult> {
    if (this.hang?.('implement', task.taskId)) return never();
    const scenario = scenarioOfTask(task);
    const workDir = this.workDir(task);
    const req = buildMockRequest({ scenario, taskTitle: scenario, turn });
    const reply = await this.provider.complete(req);
    const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    const action = /^ACTION: (.+)$/m.exec(text)?.[1]?.trim() ?? 'none';
    // One checkpointed tool call per turn, then the crash hook: the daemon
    // journals this call as a step, so a hang here leaves the task mid-turn
    // with a real step-journal entry behind it (crash-resume's implement
    // case hangs here, after exactly one step).
    const toolName =
      action === 'apply-fix adder' || action.startsWith('set-mode ') || action === 'edit-ci'
        ? 'edit_file'
        : 'bash';
    const toolCalls = [{ toolName, inputSummary: action }];
    await onToolCall({ toolName, inputSummary: action });
    if (this.hang?.('implement', task.taskId)) return never();

    if (action === 'apply-fix adder') {
      const path = join(workDir, 'src/adder.ts');
      const content = await readFile(path, 'utf8');
      if (content.includes('return a - b;')) {
        await writeFile(path, content.replace('return a - b;', 'return a + b;'));
      }
      const check = await runShell(plan.verificationCommand, workDir);
      const treeHash = await treeHashOf(workDir);
      if (check.exitCode === 0) {
        return {
          done: true,
          isReadOnly: false,
          mutatedFiles: ['src/adder.ts'],
          toolCalls,
          treeHash,
        };
      }
      return {
        done: false,
        isReadOnly: false,
        mutatedFiles: ['src/adder.ts'],
        toolCalls,
        treeHash,
        error: { message: check.stderr.trim() || 'adder test still failing', toolName: 'bash' },
      };
    }

    if (action.startsWith('set-mode ')) {
      const mode = action.slice('set-mode '.length).trim();
      const path = join(workDir, 'src/mode.ts');
      const content = await readFile(path, 'utf8');
      const next = content.replace(/= '[ab]';/, `= '${mode}';`);
      if (next !== content) await writeFile(path, next);
      const treeHash = await treeHashOf(workDir);
      return {
        done: false,
        isReadOnly: false,
        mutatedFiles: ['src/mode.ts'],
        toolCalls,
        treeHash,
      };
    }

    if (action === 'run-failing-command') {
      const result = await runShell('node scripts/fail.mjs', workDir);
      return {
        done: false,
        isReadOnly: false,
        mutatedFiles: [],
        toolCalls,
        error: {
          message: result.stderr.trim(),
          toolName: 'bash',
          inputSummary: 'node scripts/fail.mjs',
        },
      };
    }

    if (action === 'edit-ci') {
      // The guardrail throws; the daemon marks the task failed and moves on.
      try {
        assertPathAllowed('.github/workflows/ci.yml', 'write');
      } catch (err) {
        this.outcomes.failed.add(scenario);
        throw err;
      }
      throw new Error('harness: guardrail did not throw for ci.yml');
    }

    if (action === 'quarantine-flaky') {
      await runShell('node --test test/flaky.test.ts', workDir);
      return {
        done: true,
        isReadOnly: false,
        mutatedFiles: [],
        toolCalls,
      };
    }

    // Unknown action: a read-only turn (stalls toward the read-stall trip).
    return { done: false, isReadOnly: true, mutatedFiles: [], toolCalls: [] };
  }
}

class MockVerifier extends VerificationPipeline {
  constructor(
    private readonly store: AutonomousStateStore,
    private readonly outcomes: HarnessOutcomes,
    private readonly hang?: HangPredicate,
  ) {
    super();
  }

  override async verify(task: VerificationTask, worktreePath: string): Promise<VerificationResult> {
    if (this.hang?.('verify', task.id)) return never();
    const queued = this.store.getTask(task.id);
    const scenario = queued === null ? undefined : scenarioOfTask(queued);
    const fail = (diagnostic: string): VerificationResult => ({
      outcome: 'FAIL',
      repairRound: 0,
      stages: [],
      diagnostics: [diagnostic],
      bloatNeedsHumanReview: false,
      netLoc: 0,
    });
    if (scenario === 'flaky-test') {
      this.outcomes.failed.add('flaky-test');
      return fail('flaky test quarantined on clean HEAD');
    }
    const command =
      scenario === undefined ? undefined : SCENARIO_PLANS[scenario].verificationCommand;
    if (command === undefined) return fail(`unknown scenario for task ${task.id}`);
    const result = await runShell(command, worktreePath);
    if (result.exitCode !== 0) {
      if (scenario !== undefined) this.outcomes.failed.add(scenario);
      return fail(`verification failed: ${result.stderr.trim().slice(0, 200)}`);
    }
    return {
      outcome: 'PASS',
      repairRound: 0,
      stages: [],
      diagnostics: [],
      bloatNeedsHumanReview: false,
      netLoc: 0,
    };
  }
}

class MockShipper extends ShippingController {
  readonly shipped: { title: string; commitSha: string }[] = [];

  constructor(
    private readonly repoRoot: string,
    private readonly store: AutonomousStateStore,
    private readonly outcomes: HarnessOutcomes,
    private readonly shipMode: ShipMode = 'merge',
  ) {
    super({ repoRoot });
  }

  override async ship(task: ShipTask): Promise<ShipResult> {
    const queued = this.store.getTask(task.taskId);
    const scenario = queued === null ? undefined : scenarioOfTask(queued);
    const base = task.worktreePath;
    const status = await git(base, ['status', '--porcelain'], { allowFailure: true });
    if (status.exitCode !== 0) {
      return {
        taskId: task.taskId,
        tier: 1,
        riskScore: 0,
        branch: 'main',
        merged: false,
        outcome: 'push_failed',
        needsHumanApproval: false,
        note: 'git status failed',
      };
    }
    // The daemon commits the worktree before shipping, so a clean tree means
    // the fix is already committed on the detached HEAD — ship that. Only
    // commit here when the caller left uncommitted changes (older daemon).
    let sha: string;
    if (status.stdout.trim() === '') {
      sha = (await git(base, ['rev-parse', 'HEAD'])).stdout.trim();
      if (sha === '') {
        return {
          taskId: task.taskId,
          tier: 1,
          riskScore: 0,
          branch: 'main',
          merged: false,
          outcome: 'push_failed',
          needsHumanApproval: false,
          note: 'nothing to commit',
        };
      }
    } else {
      await git(base, ['add', '-A']);
      const commit = await git(
        base,
        [
          '-c',
          'user.name=omnexx-daemon',
          '-c',
          'user.email=daemon@omnexx.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          `daemon: ${scenario ?? task.title}`,
        ],
        { allowFailure: true },
      );
      if (commit.exitCode !== 0) {
        return {
          taskId: task.taskId,
          tier: 1,
          riskScore: 0,
          branch: 'main',
          merged: false,
          outcome: 'push_failed',
          needsHumanApproval: false,
          note: `commit failed: ${commit.stderr.slice(0, 200)}`,
        };
      }
      sha = (await git(base, ['rev-parse', 'HEAD'])).stdout.trim();
    }
    // Failure modes (the live 2026-11-06 ship failure): the commit exists
    // in the worktree, but the branch never lands the way a merge would.
    // `branch-pushed-pr-failed` mirrors `gh pr create` failing after a
    // successful push — branch on the remote, PR body on disk, review-queue
    // entry written, no merge. `push-failed` mirrors the push itself
    // failing — nothing reaches the remote, PR body on disk, no queue entry.
    if (this.shipMode !== 'merge') {
      const branch = `omnexx/auto/${task.taskId}`;
      const prBodyPath = join(this.repoRoot, '.omnexx', 'pr-bodies', `${task.taskId}.md`);
      await mkdir(join(this.repoRoot, '.omnexx', 'pr-bodies'), { recursive: true });
      await writeFile(prBodyPath, `# ${task.title}\n\n${sha}\n`, 'utf8');
      if (this.shipMode === 'branch-pushed-pr-failed') {
        await this.enqueue({
          taskId: task.taskId,
          tier: 2,
          riskScore: 0,
          branch,
          merged: false,
          outcome: 'branch_pushed_pr_failed',
          prBodyPath,
          needsHumanApproval: false,
          note: 'gh pr create failed (mock: no gh auth)',
        });
        return {
          taskId: task.taskId,
          tier: 2,
          riskScore: 0,
          branch,
          merged: false,
          outcome: 'branch_pushed_pr_failed',
          prBodyPath,
          needsHumanApproval: false,
          note: 'gh pr create failed (mock: no gh auth)',
        };
      }
      return {
        taskId: task.taskId,
        tier: 2,
        riskScore: 0,
        branch,
        merged: false,
        outcome: 'push_failed',
        prBodyPath,
        needsHumanApproval: false,
        note: 'branch push failed (mock: remote unreachable)',
      };
    }
    if (base !== this.repoRoot) {
      const merge = await git(this.repoRoot, ['merge', '--ff-only', sha], { allowFailure: true });
      if (merge.exitCode !== 0) {
        return {
          taskId: task.taskId,
          tier: 1,
          riskScore: 0,
          branch: 'main',
          merged: false,
          outcome: 'push_failed',
          needsHumanApproval: false,
          note: `merge failed: ${merge.stderr.slice(0, 200)}`,
        };
      }
    }
    if (scenario !== undefined) {
      this.shipped.push({ title: scenario, commitSha: sha });
      this.outcomes.shipped.push({ title: scenario, commitSha: sha });
    }
    return {
      taskId: task.taskId,
      tier: 1,
      riskScore: 0,
      branch: 'main',
      merged: true,
      outcome: 'merged',
      needsHumanApproval: false,
    };
  }
}

/**
 * What the harness shipper pretends happened: a normal merge (`merge`), a
 * branch pushed whose PR creation failed (`branch-pushed-pr-failed` — the
 * 2026-11-06 live failure), or a branch push that itself failed
 * (`push-failed`).
 */
export type ShipMode = 'merge' | 'branch-pushed-pr-failed' | 'push-failed';

export interface DaemonHarnessOptions {
  repoRoot: string;
  clock: FakeClock;
  daemonDir?: string;
  maxTurnsPerTask?: number;
  idleSleepBaseMs?: number;
  idleSleepMaxMs?: number;
  headPollMs?: number;
  /** Use the real WorktreeManager (default true); false works in place. */
  useWorktrees?: boolean;
  /** Scenarios discovery offers (default: all five). */
  scenarios?: readonly ScenarioId[];
  /** Store instance to use (created file-backed when omitted). */
  store?: AutonomousStateStore;
  /** SQLite path for a created store (default `<repoRoot>/.omnexx/autonomous.db`). */
  dbPath?: string;
  provider?: ScriptedMockLLMProvider;
  /** Crash injection: return true to hang forever at that phase for that task. */
  hang?: HangPredicate;
  /** What the mock shipper pretends happened (default: a normal merge). */
  shipMode?: ShipMode;
  logger?: DaemonLogger;
  onStateChange?: (from: DaemonState, to: DaemonState, taskId?: string) => void;
}

export interface DaemonHarness {
  daemon: AutonomousDaemon;
  store: AutonomousStateStore;
  dbPath: string;
  clock: FakeClock;
  provider: ScriptedMockLLMProvider;
  shipper: MockShipper;
  verifier: MockVerifier;
  executor: MockTaskExecutor;
  worktrees: WorktreeManager | undefined;
  daemonDir: string;
  repoRoot: string;
  outcomes: HarnessOutcomes;
  logs: string[];
}

/**
 * Build a daemon wired to scripted collaborators over a fixture repo.
 * The caller owns boot/start/stop: `await daemon.boot()` then either
 * `await daemon.start({ maxCycles })` or a manual `runCycle()` loop
 * followed by `await daemon.stop()`.
 */
export function createDaemonHarness(opts: DaemonHarnessOptions): DaemonHarness {
  const clock: Clock = opts.clock;
  const dbPath = opts.dbPath ?? join(opts.repoRoot, '.omnexx', 'autonomous.db');
  const store = opts.store ?? new AutonomousStateStore({ repoRoot: opts.repoRoot, dbPath });
  const provider = opts.provider ?? new ScriptedMockLLMProvider();
  const outcomes = new HarnessOutcomes();
  const logs: string[] = [];
  const logger: DaemonLogger = opts.logger ?? {
    log: (msg: string) => {
      logs.push(`log: ${msg}`);
    },
    warn: (msg: string) => {
      logs.push(`warn: ${msg}`);
    },
    error: (msg: string) => {
      logs.push(`error: ${msg}`);
    },
  };
  const daemonDir = opts.daemonDir ?? join(opts.repoRoot, '.omnexx');
  const useWorktrees = opts.useWorktrees ?? true;
  const realWorktrees = useWorktrees ? new WorktreeManager({ repoRoot: opts.repoRoot }) : undefined;
  const shipper = new MockShipper(opts.repoRoot, store, outcomes, opts.shipMode ?? 'merge');
  const verifier = new MockVerifier(store, outcomes, opts.hang);
  const executor = new MockTaskExecutor(
    opts.repoRoot,
    provider,
    realWorktrees,
    outcomes,
    opts.hang,
  );

  const onStateChange = (from: DaemonState, to: DaemonState, taskId?: string): void => {
    outcomes.transitions.push({ from, to, taskId });
    if (to === 'quarantine' && taskId !== undefined) {
      const info = outcomes.titlesById.get(taskId);
      if (info !== undefined) {
        const tomb = store.getTombstone(info.fingerprint);
        outcomes.quarantined.set(info.title, {
          strikes: tomb?.strikeCount ?? 0,
          untilMs: tomb === null || tomb.cooldownUntilMs === -1 ? undefined : tomb.cooldownUntilMs,
        });
      }
    }
    opts.onStateChange?.(from, to, taskId);
  };

  const daemon = new AutonomousDaemon({
    repoRoot: opts.repoRoot,
    daemonDir,
    store,
    clock,
    discovery: new MockDiscovery(opts.repoRoot, opts.scenarios ?? SCENARIO_IDS, outcomes),
    triage: new TriageEngine(store, { repoRoot: opts.repoRoot, now: () => clock.now() }),
    planner: new MockPlanner(outcomes, opts.hang),
    executor,
    verifier,
    shipper,
    worktrees: realWorktrees,
    logger,
    onStateChange,
    maxTurnsPerTask: opts.maxTurnsPerTask ?? 25,
    idleSleepBaseMs: opts.idleSleepBaseMs ?? 1000,
    idleSleepMaxMs: opts.idleSleepMaxMs ?? 1000,
    headPollMs: opts.headPollMs ?? 3_600_000,
    watchdogStallMs: 300_000,
  });

  return {
    daemon,
    store,
    dbPath,
    clock: opts.clock,
    provider,
    shipper,
    verifier,
    executor,
    worktrees: realWorktrees,
    daemonDir,
    repoRoot: opts.repoRoot,
    outcomes,
    logs,
  };
}
