/**
 * AutonomousDaemon — the 24/7 Autonomous Development Daemon state machine.
 *
 * States: IDLE → DISCOVER → TRIAGE → PLAN → IMPLEMENT → VERIFY → SHIP → LEARN,
 * plus QUARANTINE (circuit-breaker trip / poisoned task) and BUDGET_PAUSE
 * (outside a budget window). Every transition is persisted to SQLite via the
 * real `AutonomousStateStore`; the daemon drives ONE task per cycle and calls
 * into the supervisor execution path for IMPLEMENT (via the injected
 * TaskExecutor) rather than duplicating the supervisor loop.
 *
 * Sibling modules are imported for real: state-store, discovery, triage,
 * quality-ratchet, verification-pipeline, shipping, worktree-manager. The
 * LLM-backed pieces (Architect planner, task executor) have no sibling module
 * and are injected; the bundled path fails closed when they are absent.
 *
 * Known cross-worker mismatches (not mine to fix in their files):
 * - discovery's RawFinding has no `kind`/`hotness`/`blastRadius`/`tokenCost`,
 *   but triage's RawFinding requires them — see `adaptFinding` below.
 * - The tombstone ladder is defined once in the state store
 *   (`TOMBSTONE_COOLDOWNS_MS`: 1h/6h/24h/7d, permanent at strike 5) and
 *   mirrored by `tombstoneCooldownMs` in circuit-breaker.ts for reporting.
 *   The store's ladder governs persistence.
 */
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { LockError } from '../errors.js';
import { readBootId } from '../daemon/boot-id.js';
import { git } from '../git/git.js';
import { blobsChanged } from './fingerprint.js';
import { realClock, type Clock } from '../core/clock.js';
import { isStale, lockSchema, pidAlive } from '../core/lock.js';
import type { AutonomousStateStore } from './state-store.js';
import { type QueuedTask, type TaskStatus } from './state-store.js';
import type { DiscoveryOrchestrator } from './discovery/index.js';
import { type RawFinding as DiscoveryRawFinding } from './discovery/index.js';
import type { TriageEngine } from './triage.js';
import { type FindingKind, type RawFinding as TriageRawFinding } from './triage.js';
import type { QualityRatchet } from './quality-ratchet.js';
import type { VerificationPipeline } from './verification-pipeline.js';
import {
  MAX_REPAIR_ROUNDS,
  type VerificationOutcome,
  type VerificationTaskKind,
} from './verification-pipeline.js';
import type { ShippingController } from './shipping.js';
import { collectChangeStats, type ChangeCategory } from './shipping.js';
import type { WorktreeManager } from './worktree-manager.js';
import { TaskCircuitBreaker, WatchdogMonitor, type CircuitTrip } from './circuit-breaker.js';

export type DaemonState =
  | 'idle'
  | 'discover'
  | 'triage'
  | 'plan'
  | 'implement'
  | 'verify'
  | 'ship'
  | 'learn'
  | 'quarantine'
  | 'budget_pause';

export const DAEMON_STATES: readonly DaemonState[] = [
  'idle',
  'discover',
  'triage',
  'plan',
  'implement',
  'verify',
  'ship',
  'learn',
  'quarantine',
  'budget_pause',
];

/** Daemon states that map onto a persisted per-task status. */
const STATE_TO_TASK_STATUS: Partial<Record<DaemonState, TaskStatus>> = {
  plan: 'PLANNING',
  implement: 'IMPLEMENTING',
  verify: 'VERIFYING',
  budget_pause: 'PAUSED_BUDGET',
};

/** Active statuses whose tasks are candidates for stale-lease reclaim on boot. */
const ACTIVE_STATUSES: readonly TaskStatus[] = ['PLANNING', 'IMPLEMENTING', 'VERIFYING'];

// ---------------------------------------------------------------------------
// Injected LLM-backed pieces (no sibling module owns these)
// ---------------------------------------------------------------------------

/** A bounded plan produced by a single-turn Architect prompt. */
export interface TaskExecutionPlan {
  /** Files the task may touch; bounded to ≤ 6. */
  filesToTouch: string[];
  /** The command that verifies the task (tests / typecheck / lint). */
  verificationCommand: string;
  /** Sub-steps of the implementation; bounded to ≤ 5. */
  subSteps: string[];
  summary: string;
}

export const MAX_PLAN_FILES = 6;
export const MAX_PLAN_SUB_STEPS = 5;

/** Clamp a plan to the daemon's bounds (files ≤ 6, sub-steps ≤ 5). */
export function boundPlan(plan: TaskExecutionPlan): TaskExecutionPlan {
  return {
    filesToTouch: plan.filesToTouch.slice(0, MAX_PLAN_FILES),
    verificationCommand: plan.verificationCommand,
    subSteps: plan.subSteps.slice(0, MAX_PLAN_SUB_STEPS),
    summary: plan.summary,
  };
}

/** Single-turn Architect prompt; injected (LLM-backed). */
export interface ArchitectPlanner {
  plan(task: QueuedTask): Promise<TaskExecutionPlan>;
}

export interface ToolCallRecord {
  toolName: string;
  inputSummary?: string | undefined;
  errorContent?: string | undefined;
}

/**
 * One turn of the IMPLEMENT loop. The daemon drives the loop and the circuit
 * breaker; the executor runs the supervisor execution path for a single turn
 * inside the task worktree. `onToolCall` fires per tool call so the daemon can
 * checkpoint every tool call to the step journal.
 */
export interface TurnResult {
  done: boolean;
  isReadOnly: boolean;
  mutatedFiles: string[];
  toolCalls: ToolCallRecord[];
  /** `git write-tree` hash after this turn, when a mutation happened. */
  treeHash?: string | undefined;
  /** pgid of the child process group this turn's work ran in (watchdog kills). */
  childPgid?: number | undefined;
  /** Error that ended the turn, if any. */
  error?: { message: string; toolName?: string; inputSummary?: string } | undefined;
}

export interface TaskExecutor {
  executeTurn(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    turn: number,
    signal: AbortSignal,
    onToolCall: (call: ToolCallRecord) => void | Promise<void>,
    nudge?: string,
  ): Promise<TurnResult>;
  /** Destroy the task's agent context (LEARN). Optional. */
  disposeTaskContext?: (taskId: string) => void | Promise<void>;
}

/** Budget gate (no sibling budget module exists yet; injected when one lands). */
export interface BudgetGate {
  check(nowMs: number): Promise<{ ok: boolean; reason?: string }>;
}

export type DaemonLogger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface AutonomousDaemonOptions {
  repoRoot: string;
  /** Defaults to `<repoRoot>/.omnexx`. Holds daemon.lock. */
  daemonDir?: string | undefined;
  /**
   * Path to `.omnexx/daemon-control.json` (written by `daemon pause|resume|stop`).
   * When set, the daemon polls it at IDLE sleep boundaries and while paused, so
   * a pause/resume/stop takes effect even when the SIGSTOP/SIGCONT/SIGTERM
   * never reaches the process. Unset: no polling (the signal path only).
   */
  controlPath?: string | undefined;
  store: AutonomousStateStore;
  clock?: Clock | undefined;
  discovery?: DiscoveryOrchestrator | undefined;
  triage?: TriageEngine | undefined;
  planner?: ArchitectPlanner | undefined;
  executor?: TaskExecutor | undefined;
  verifier?: VerificationPipeline | undefined;
  shipper?: ShippingController | undefined;
  worktrees?: WorktreeManager | undefined;
  budget?: BudgetGate | undefined;
  qualityRatchet?: QualityRatchet | undefined;
  logger?: DaemonLogger | undefined;
  onStateChange?: ((from: DaemonState, to: DaemonState, taskId?: string) => void) | undefined;
  /** Max IMPLEMENT turns per task. Default 25. */
  maxTurnsPerTask?: number | undefined;
  /** Base IDLE sleep; doubled per empty streak up to max. Default 60_000 ms. */
  idleSleepBaseMs?: number | undefined;
  /** IDLE sleep ceiling. Default 3_600_000 ms (1h). */
  idleSleepMaxMs?: number | undefined;
  /** How often to poll `git rev-parse HEAD` while idling. Default 10_000 ms. */
  headPollMs?: number | undefined;
  /** Watchdog stall threshold. Default 300_000 ms. */
  watchdogStallMs?: number | undefined;
  /**
   * Active task with no update for longer than this is a stale lease on boot.
   * The real store has no lease concept; staleness is judged by updatedAtMs.
   * Default 1_800_000 ms (30 min, the task wall-clock lease).
   */
  staleLeaseMs?: number | undefined;
}

/** Fail-closed stub for LLM-backed pieces not yet injected. */

/**
 * Discovery → triage adapter. Discovery's RawFinding carries no `kind`,
 * `hotness`, `blastRadius` or `tokenCost`, but triage's RawFinding requires
 * them. Kind is inferred from the collector name; the cost/radius signals
 * default to neutral until the discovery worker adds them.
 */
const COLLECTOR_KIND: Record<string, FindingKind> = {
  test_runner: 'failing-test',
  'test-runner': 'failing-test',
  typecheck: 'type-error',
  'static-analysis': 'type-error',
  'coverage-churn': 'uncovered-critical',
  complexity: 'complexity',
  'todo-mining': 'todo',
  dependency: 'patch-dependency',
};

export function adaptFinding(finding: DiscoveryRawFinding): TriageRawFinding {
  const adapted: TriageRawFinding = {
    collector: finding.collector,
    ruleOrTestId: finding.ruleOrTestId,
    targetFiles: [...finding.targetFiles],
    kind: COLLECTOR_KIND[finding.collector] ?? 'todo',
    confidence: finding.confidence,
    verification: finding.verification,
    hotness: finding.severity,
    blastRadius: 0.5,
    tokenCost: 0.5,
    payload: finding.findingPayload,
  };
  if (finding.canonicalSymbol !== undefined) adapted.symbol = finding.canonicalSymbol;
  return adapted;
}

const FINDING_KIND_TO_VERIFICATION_KIND: Record<FindingKind, VerificationTaskKind> = {
  'failing-test': 'test_runner',
  'uncovered-critical': 'coverage_gap',
  complexity: 'refactor',
  cve: 'bugfix',
  'type-error': 'bugfix',
  'patch-dependency': 'bugfix',
  todo: 'other',
};

const FINDING_KIND_TO_CHANGE_CATEGORY: Record<FindingKind, ChangeCategory> = {
  'failing-test': 'bug-fix',
  cve: 'bug-fix',
  'type-error': 'bug-fix',
  'uncovered-critical': 'test-only',
  'patch-dependency': 'dep-update',
  complexity: 'refactor',
  todo: 'refactor',
};

/** Read the finding kind back off a queued task's stored payload, if present. */
function findingKindOf(task: QueuedTask): FindingKind {
  const payload = task.findingPayload as { kind?: unknown } | null;
  const kind = typeof payload === 'object' && payload !== null ? payload.kind : undefined;
  return typeof kind === 'string' && kind in FINDING_KIND_TO_VERIFICATION_KIND
    ? (kind as FindingKind)
    : 'todo';
}

/**
 * What `shipTask` hands to `learnTask` once a task's final ship outcome is
 * known. `deliveryMode` is what lands in done_set: `'auto'` for a merged /
 * PR ship, `'auto:branch-only'` when the branch pushed but no PR was opened
 * — the work is done and must not be re-proposed, but a human still has to
 * open the PR from `prBodyPath` (the review queue already holds the branch).
 */
interface ShipCompletion {
  shippedCommitSha: string;
  deliveryMode: string;
  branch: string;
  /** Path of the PR body left on disk when no PR was opened, if any. */
  prBodyPath?: string | undefined;
}

/** Daemon PID lock on `<daemonDir>/daemon.lock`, reusing the lock.ts pattern. */
async function acquireDaemonLock(
  daemonDir: string,
  bootId: string,
  now: number,
): Promise<{ release: () => Promise<void> }> {
  const path = join(daemonDir, 'daemon.lock');
  const mine = { pid: process.pid, host: hostname(), bootId, startedAt: now };
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(mine));
        await fh.sync();
      } finally {
        await fh.close();
      }
      return {
        release: async (): Promise<void> => {
          try {
            const held = lockSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
            if (held.success && held.data.pid === process.pid) await rm(path, { force: true });
          } catch {
            // Lock already gone; nothing to release.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const parsed = await readFile(path, 'utf8').then(
      (text) => lockSchema.safeParse(JSON.parse(text)),
      () => null,
    );
    if (!parsed?.success) {
      // Unparseable lock: stale/corrupt; remove it and retry.
      await rm(path, { force: true });
      continue;
    }
    if (!isStale(parsed.data, { host: hostname(), bootId, isAlive: pidAlive })) {
      throw new LockError(
        `autonomous daemon already running as pid ${parsed.data.pid} on ${parsed.data.host}`,
        '`omnexx status` shows its heartbeat',
      );
    }
    await rm(path, { force: true });
  }
  throw new LockError('could not take the daemon lock', 'remove .omnexx/daemon.lock by hand');
}

export class AutonomousDaemon {
  private readonly repoRoot: string;
  private readonly daemonDir: string;
  private readonly controlPath: string | undefined;
  private readonly store: AutonomousStateStore;
  private readonly clock: Clock;
  private readonly discovery?: DiscoveryOrchestrator | undefined;
  private readonly triage?: TriageEngine | undefined;
  private readonly planner?: ArchitectPlanner | undefined;
  private readonly executor?: TaskExecutor | undefined;
  private readonly verifier?: VerificationPipeline | undefined;
  private readonly shipper?: ShippingController | undefined;
  private readonly worktrees?: WorktreeManager | undefined;
  private readonly budget?: BudgetGate | undefined;
  private readonly qualityRatchet?: QualityRatchet | undefined;
  private readonly logger: DaemonLogger;
  private readonly onStateChange?: AutonomousDaemonOptions['onStateChange'];
  private readonly maxTurnsPerTask: number;
  private readonly idleSleepBaseMs: number;
  private readonly idleSleepMaxMs: number;
  private readonly headPollMs: number;
  private readonly watchdogStallMs: number;
  private readonly staleLeaseMs: number;

  private state: DaemonState = 'idle';
  private currentTask: QueuedTask | undefined;
  private currentBreaker: TaskCircuitBreaker | undefined;
  /** Tasks already quarantined in this process — guards the watchdog/loop race. */
  private readonly quarantinedTaskIds = new Set<string>();
  private emptyStreak = 0;
  private lastHead: string | undefined;
  private booted = false;
  private running = false;
  private paused = false;
  private readonly abortController = new AbortController();
  private releaseLock: (() => Promise<void>) | undefined;
  private loopDone: Promise<void> | undefined;
  private readonly watchdog: WatchdogMonitor;
  private readonly onSignal: () => void;

  constructor(options: AutonomousDaemonOptions) {
    this.repoRoot = options.repoRoot;
    this.daemonDir = options.daemonDir ?? join(options.repoRoot, '.omnexx');
    this.controlPath = options.controlPath;
    this.store = options.store;
    this.clock = options.clock ?? realClock;
    this.discovery = options.discovery;
    this.triage = options.triage;
    this.planner = options.planner;
    this.executor = options.executor;
    this.verifier = options.verifier;
    this.shipper = options.shipper;
    this.worktrees = options.worktrees;
    this.budget = options.budget;
    this.qualityRatchet = options.qualityRatchet;
    this.logger = options.logger ?? console;
    this.onStateChange = options.onStateChange;
    this.maxTurnsPerTask = options.maxTurnsPerTask ?? 25;
    this.idleSleepBaseMs = options.idleSleepBaseMs ?? 60_000;
    this.idleSleepMaxMs = options.idleSleepMaxMs ?? 3_600_000;
    this.headPollMs = options.headPollMs ?? 10_000;
    this.watchdogStallMs = options.watchdogStallMs ?? 300_000;
    this.staleLeaseMs = options.staleLeaseMs ?? 1_800_000;
    this.watchdog = new WatchdogMonitor({
      stallMs: this.watchdogStallMs,
      onStall: async (info) => {
        this.logger.error(
          `[daemon] watchdog: no progress for ${Math.round(info.stalledForMs / 1000)}s` +
            (info.taskId ? ` on ${info.taskId}` : '') +
            ' — aborting task, quarantining, forcing IDLE',
        );
        // Abort the current task's breaker, NOT the daemon's main controller:
        // a stall forces IDLE, it does not stop the daemon.
        this.currentBreaker?.abort('watchdog stall');
        if (info.taskId) {
          const task = this.currentTask?.taskId === info.taskId ? this.currentTask : undefined;
          if (task) await this.quarantineTask(task, 'watchdog_stall');
        }
        this.transition('idle');
      },
    });
    this.onSignal = () => {
      this.logger.log('[daemon] signal received, stopping gracefully…');
      void this.stop();
    };
  }

  get currentState(): DaemonState {
    return this.state;
  }

  get task(): QueuedTask | undefined {
    return this.currentTask;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // boot(): 4-step crash-recovery reconciliation
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    if (this.booted) return;
    await mkdir(this.daemonDir, { recursive: true });
    const bootId = await readBootId();

    // 1. Acquire the PID lock on .omnexx/daemon.lock (stale holder = reaped).
    this.releaseLock = (await acquireDaemonLock(this.daemonDir, bootId, this.clock.now())).release;
    await this.store.open();

    const now = this.clock.now();

    // 2. Reclaim stale leases (see reclaimStaleLeases for why this runs
    //    here and at the top of every cycle, not just at boot).
    this.reclaimStaleLeases(now);

    // 3. Verify each active task's worktree tree-hash against its step journal:
    //    resume if clean, reset to the last checkpoint if corrupt.
    for (const status of ACTIVE_STATUSES) {
      for (const task of this.store.listTasks(status)) {
        if (!task.worktreePath) continue;
        const steps = this.store.getSteps(task.taskId);
        const last = steps[steps.length - 1];
        const treeHash = await this.worktreeTreeHash(task.worktreePath);
        if (treeHash === undefined) {
          // Worktree dir is gone: requeue from scratch.
          this.store.updateTaskStatus(task.taskId, 'QUEUED', { worktreePath: null });
          this.logger.warn(`[daemon] worktree for ${task.taskId} is gone; requeued`);
          continue;
        }
        if (last?.gitTreeHash == null || last.gitTreeHash === treeHash) continue; // clean
        this.logger.warn(
          `[daemon] worktree for ${task.taskId} diverged from step journal ` +
            `(journal ${last.gitTreeHash}, actual ${treeHash}); resetting to last checkpoint`,
        );
        if (this.worktrees && /^[0-9a-f]{40}$/.test(last.gitTreeHash)) {
          await this.worktrees.resetToCheckpoint(task.taskId, last.gitTreeHash);
          this.store.recordStep(task.taskId, {
            phase: 'idle',
            gitTreeHash: last.gitTreeHash,
            errorSignature: 'worktree reset to last checkpoint tree',
          });
        } else {
          // No checkpoint tree to trust: requeue from scratch.
          this.store.updateTaskStatus(task.taskId, 'QUEUED', { worktreePath: null });
          this.store.recordStep(task.taskId, {
            phase: 'idle',
            errorSignature: 'worktree corrupt with no checkpoint; requeued',
          });
        }
      }
    }

    // 4. Prune done_set: drop entries whose target blobs have changed since
    //    the task shipped (the recorded work is stale; a similar finding may
    //    legitimately recur). Entries with no target files are never pruned.
    let pruned = 0;
    for (const entry of this.store.listDone()) {
      const { changed } = blobsChanged(this.repoRoot, entry.fingerprint, entry.targetBlobHashes);
      if (changed) {
        this.store.deleteDone(entry.fingerprint);
        pruned++;
      }
    }
    this.logger.log(`[daemon] boot step 4: pruned ${pruned} stale done_set entries`);

    this.lastHead = await this.currentHead();
    this.booted = true;
    this.logger.log('[daemon] boot reconciliation complete');
  }

  /**
   * Stale-lease reclaim: tasks stuck in PLANNING / IMPLEMENTING / VERIFYING
   * with no update for longer than the lease go back to QUEUED.
   *
   * Why this runs at the top of every cycle as well as at boot: reclaim used
   * to be boot-only, so a task orphaned while the daemon stayed alive — the
   * ship-failure case, where the daemon moved on to the next task and left
   * the previous one in VERIFYING — was never reclaimed until the next
   * restart, however long the daemon ran. At a cycle boundary no task is in
   * flight (`processTask` is awaited inside `runCycle`), so any ACTIVE task
   * seen here is necessarily orphaned.
   *
   * Staleness is judged by `updatedAtMs`, which the store stamps only on a
   * status transition — step-journal writes do NOT bump it, so a task goes
   * stale 30 min after it entered its phase. That also means a phase that
   * legitimately runs long looks stale by the clock; what protects it is
   * that reclaim only fires at a cycle boundary, never mid-task, so a live
   * IMPLEMENT/VERIFY is never interrupted by it.
   */
  private reclaimStaleLeases(nowMs: number, context = 'boot'): void {
    for (const status of ACTIVE_STATUSES) {
      for (const task of this.store.listTasks(status)) {
        if (nowMs - task.updatedAtMs > this.staleLeaseMs) {
          this.store.updateTaskStatus(task.taskId, 'QUEUED');
          this.store.recordStep(task.taskId, {
            phase: 'idle',
            errorSignature: `stale lease reclaimed on ${context}`,
          });
          this.logger.log(`[daemon] reclaimed stale lease on ${task.taskId}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // start / stop / pause / resume
  // -------------------------------------------------------------------------

  /**
   * Main loop: one task per cycle until stopped. `maxCycles` bounds the loop
   * (smoke tests / dry runs); omitted means run forever. Resolves when the
   * loop exits.
   */
  async start(options: { maxCycles?: number } = {}): Promise<void> {
    if (this.running) return this.loopDone ?? Promise.resolve();
    await this.boot();
    this.running = true;
    this.watchdog.start();
    process.once('SIGINT', this.onSignal);
    process.once('SIGTERM', this.onSignal);
    this.loopDone = (async () => {
      let cycles = 0;
      try {
        while (
          !this.abortController.signal.aborted &&
          (options.maxCycles === undefined || cycles < options.maxCycles)
        ) {
          if (this.paused) {
            // Control-file polling: a `resume`/`stop` written while paused
            // takes effect here even if SIGCONT/SIGTERM never arrived.
            const action = this.readControlAction();
            if (action === 'resume') {
              this.resume();
            } else if (action === 'stop') {
              this.abortController.abort(new Error('daemon stop requested via control file'));
            } else {
              await this.clock.sleep(1000, this.abortController.signal).catch(() => undefined);
            }
            continue;
          }
          await this.runCycle();
          cycles++;
        }
      } catch (err) {
        if (!this.abortController.signal.aborted) {
          this.logger.error(`[daemon] cycle failed: ${(err as Error).message}`);
        }
      } finally {
        this.running = false;
        await this.shutdown();
      }
    })();
    return this.loopDone;
  }

  async stop(): Promise<void> {
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error('daemon stop'));
    await this.loopDone?.catch(() => undefined);
    // Release the lock even if start() was never called (boot() alone holds it).
    if (this.running || this.releaseLock) await this.shutdown();
  }

  /** Pause at the next cycle boundary, checkpointing the current task. */
  pause(): void {
    this.paused = true;
    if (this.currentTask) {
      try {
        this.store.recordStep(this.currentTask.taskId, {
          phase: this.state,
          errorSignature: 'paused by operator',
        });
      } catch {
        // Best effort checkpoint.
      }
    }
    this.logger.log('[daemon] paused');
  }

  resume(): void {
    this.paused = false;
    this.logger.log('[daemon] resumed');
  }

  private async shutdown(): Promise<void> {
    process.removeListener('SIGINT', this.onSignal);
    process.removeListener('SIGTERM', this.onSignal);
    this.watchdog.stop();
    if (this.currentTask) {
      try {
        this.store.recordStep(this.currentTask.taskId, {
          phase: this.state,
          errorSignature: 'daemon shutdown',
        });
      } catch {
        // Best effort checkpoint.
      }
    }
    await this.releaseLock?.().catch(() => undefined);
    this.releaseLock = undefined;
    try {
      this.store.close();
    } catch {
      // Store already closed.
    }
    this.booted = false;
    this.logger.log('[daemon] stopped');
  }

  // -------------------------------------------------------------------------
  // One cycle: IDLE → DISCOVER → TRIAGE → (one task through the pipeline)
  // -------------------------------------------------------------------------

  async runCycle(): Promise<void> {
    this.transition('idle');

    // Reclaim orphans left by an earlier cycle (e.g. a crash between cycles
    // or a task the daemon abandoned) before picking up new work. Skipped
    // while a task is in flight — runCycle is only re-entered between tasks,
    // so currentTask is normally undefined here; the guard is belt-and-braces
    // against a concurrent caller reclaiming the live task.
    if (!this.currentTask) this.reclaimStaleLeases(this.clock.now(), 'cycle');

    // Budget windows gate everything: outside a window we park in BUDGET_PAUSE.
    if (this.budget) {
      const check = await this.budget.check(this.clock.now());
      if (!check.ok) {
        this.transition('budget_pause');
        this.logger.log(`[daemon] budget pause: ${check.reason ?? 'outside budget window'}`);
        await this.clock
          .sleep(this.idleSleepBaseMs, this.abortController.signal)
          .catch(() => undefined);
        return;
      }
    }

    const task = this.store.popNextTask() ?? (await this.discoverAndTriage());
    if (!task) {
      // Empty queue: back to IDLE, then adaptive backoff, waking early on HEAD.
      this.transition('idle');
      this.emptyStreak++;
      const sleepMs = Math.min(this.idleSleepMaxMs, this.idleSleepBaseMs * 2 ** this.emptyStreak);
      this.logger.log(
        `[daemon] queue empty, sleeping ${Math.round(sleepMs / 1000)}s (streak ${this.emptyStreak})`,
      );
      await this.sleepWithHeadWatch(sleepMs);
      return;
    }
    this.emptyStreak = 0;
    await this.processTask(task);
  }

  /**
   * DISCOVER → TRIAGE: zero LLM tokens. Collectors run, each finding is
   * triaged (triage enqueues admitted tasks itself), and the next queued
   * task is returned, if any.
   */
  private async discoverAndTriage(): Promise<QueuedTask | null> {
    if (!this.discovery) return null;
    this.transition('discover');
    const { findings, errors } = await this.discovery.collect(this.repoRoot);
    for (const [collector, error] of Object.entries(errors)) {
      this.logger.warn(`[daemon] discovery collector ${collector} failed: ${error}`);
    }
    if (findings.length === 0) return null;
    this.transition('triage');
    if (!this.triage) {
      this.logger.warn('[daemon] no triage engine injected; findings dropped');
      return null;
    }
    let admitted = 0;
    for (const finding of findings) {
      const decision = this.triage.triageFinding(adaptFinding(finding));
      if (decision.decision === 'admitted') admitted++;
    }
    this.logger.log(`[daemon] triage: ${admitted}/${findings.length} findings admitted`);
    return this.store.popNextTask();
  }

  // -------------------------------------------------------------------------
  // One task through PLAN → IMPLEMENT → VERIFY → SHIP → LEARN
  // -------------------------------------------------------------------------

  private async processTask(task: QueuedTask): Promise<void> {
    this.currentTask = task;
    this.watchdog.noteProgress(task.taskId);
    try {
      const plan = await this.planTask(task);
      const worktree = await this.prepareWorktree(task);
      // IMPLEMENT → VERIFY loop: a REPAIR verdict sends the task back to
      // IMPLEMENT with the verification diagnostics as the opening nudge, up
      // to MAX_REPAIR_ROUNDS (the pipeline FAILs at that round, which ends
      // the loop via quarantine). Each repair round gets its own 25-turn
      // circuit-breaker budget; the 30-min wall-clock lease still bounds the
      // task as a whole.
      let repairRound = 0;
      let repairNudge: string | undefined;
      let revertProof = false;
      for (;;) {
        const implemented = await this.implementTask(task, plan, worktree, repairNudge);
        if (!implemented) return; // tripped / quarantined inside IMPLEMENT.
        const verification = await this.verifyTask(task, worktree, repairRound);
        if (verification.outcome === 'PASS') {
          revertProof = verification.revertProof;
          break;
        }
        if (verification.outcome === 'FAIL') return; // quarantined inside VERIFY.
        repairRound++;
        repairNudge =
          `Verification failed (repair round ${repairRound} of ${MAX_REPAIR_ROUNDS}): ` +
          verification.diagnostics.join('; ');
      }
      const shipResult = await this.shipTask(task, plan, worktree, revertProof);
      if (!shipResult) return;
      await this.learnTask(task, plan, worktree, shipResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[daemon] task ${task.taskId} failed: ${message}`);
      try {
        this.store.recordStep(task.taskId, {
          phase: this.state,
          errorSignature: message.slice(0, 500),
        });
      } catch {
        // Best effort.
      }
      if (message.includes('not configured')) {
        // Missing collaborator (planner/verifier/shipper): a config problem,
        // not a task failure. Leave the task in place and fail closed.
        await this.releaseWorktree(task).catch(() => undefined);
        this.transition('idle', task.taskId);
      } else {
        // Genuine task failure (guardrail throw, infra error, ...): tombstone
        // it instead of leaving it stuck in PLANNING/IMPLEMENTING forever.
        await this.quarantineTask(task, 'task_error');
      }
    } finally {
      this.currentTask = undefined;
      this.quarantinedTaskIds.delete(task.taskId);
      this.watchdog.clearTask();
    }
  }

  /** PLAN: single-turn Architect prompt producing a bounded TaskExecutionPlan. */
  private async planTask(task: QueuedTask): Promise<TaskExecutionPlan> {
    this.transition('plan', task.taskId);
    const planner = this.planner;
    if (!planner) {
      throw new Error('autonomous daemon: Architect planner is not configured');
    }
    const raw = await planner.plan(task);
    const plan = boundPlan(raw);
    if (!plan.verificationCommand.trim()) {
      throw new Error(`plan for ${task.taskId} has no verification command`);
    }
    if (plan.filesToTouch.length < raw.filesToTouch.length) {
      this.logger.warn(
        `[daemon] plan for ${task.taskId} clamped from ${raw.filesToTouch.length} to ${MAX_PLAN_FILES} files`,
      );
    }
    this.store.recordStep(task.taskId, {
      phase: 'plan',
      errorSignature:
        `plan: ${plan.summary} (${plan.filesToTouch.length} files, ${plan.subSteps.length} steps)`.slice(
          0,
          500,
        ),
    });
    return plan;
  }

  /**
   * Create the task worktree and record the baseline QualityRatchet metrics in
   * it. Falls back to working in place (repoRoot) until a worktree manager is
   * injected.
   */
  private async prepareWorktree(task: QueuedTask): Promise<string> {
    const baseSha = task.baseCommitSha ?? (await this.currentHead()) ?? 'HEAD';
    const worktree = this.worktrees
      ? (await this.worktrees.create(task.taskId, baseSha)).path
      : this.repoRoot;
    if (this.worktrees) {
      this.store.updateTaskStatus(task.taskId, 'IMPLEMENTING', { worktreePath: worktree });
      // The in-memory task is the snapshot popNextTask() returned: the DB row
      // now knows the worktree, but this object does not. The executor reads
      // task.worktreePath to root its tools — without this assignment it
      // would edit the main repo instead of the worktree.
      task.worktreePath = worktree;
    }
    if (this.qualityRatchet) {
      const baseline = await this.qualityRatchet.captureBaseline(worktree).catch((err: unknown) => {
        this.logger.warn(
          `[daemon] quality baseline failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      });
      if (baseline) {
        this.store.recordStep(task.taskId, {
          phase: 'plan',
          errorSignature:
            `baseline: ${baseline.testSuiteDurationMs}ms suite, ${baseline.lintErrorCount} lint errors`.slice(
              0,
              500,
            ),
        });
      }
    }
    return worktree;
  }

  /**
   * IMPLEMENT: bounded coding loop (max 25 turns) inside the task worktree.
   * Every tool call is checkpointed to the step journal; the circuit breaker is
   * evaluated after every turn. Returns true on success, false when the task
   * tripped and was quarantined.
   */
  private async implementTask(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    worktree: string,
    initialNudge?: string,
  ): Promise<boolean> {
    this.transition('implement', task.taskId);
    const breaker = new TaskCircuitBreaker({
      maxTurnsPerTask: this.maxTurnsPerTask,
      onTrip: (trip) => {
        this.logger.warn(`[daemon] circuit breaker tripped on ${task.taskId}: ${trip.reason}`);
      },
    });
    breaker.beginTask();
    this.currentBreaker = breaker;
    const executor = this.executor;
    if (!executor) {
      throw new Error('autonomous daemon: task executor is not configured');
    }
    let pendingNudge: string | undefined = initialNudge;
    let done = false;
    try {
      for (let turn = 1; turn <= this.maxTurnsPerTask; turn++) {
        if (breaker.signal.aborted) break;
        const result = await executor.executeTurn(
          task,
          plan,
          turn,
          breaker.signal,
          (call) => {
            // Checkpoint every tool call to the step journal.
            const step: {
              phase: string;
              toolName: string;
              errorSignature?: string;
            } = { phase: 'implement', toolName: call.toolName };
            if (call.errorContent !== undefined) {
              step.errorSignature = call.errorContent.slice(0, 500);
            }
            this.store.recordStep(task.taskId, step);
            this.watchdog.noteProgress(task.taskId);
          },
          pendingNudge,
        );
        if (result.childPgid !== undefined) {
          this.watchdog.registerChildProcessGroup(result.childPgid, task.taskId);
        }
        // Checkpoint the turn's tree state (also the boot-reconciliation anchor).
        const treeHash =
          result.treeHash ??
          (result.mutatedFiles.length > 0 ? await this.worktreeTreeHash(worktree) : undefined);
        const step: {
          phase: string;
          gitTreeHash?: string;
          errorSignature?: string;
        } = { phase: 'implement' };
        if (treeHash !== undefined) step.gitTreeHash = treeHash;
        step.errorSignature = `turn ${turn} complete${result.done ? ' (done)' : ''}`;
        this.store.recordStep(task.taskId, step);
        this.watchdog.noteProgress(task.taskId);

        const evaluation = breaker.evaluateTurn({
          done: result.done,
          isReadOnly: result.isReadOnly,
          toolName: result.error?.toolName,
          inputSummary: result.error?.inputSummary,
          errorContent: result.error?.message,
          treeHash,
        });
        pendingNudge = evaluation.nudge;
        if (evaluation.trip) {
          await this.quarantineTask(task, evaluation.trip.reason, evaluation.trip);
          return false;
        }
        if (result.done) {
          done = true;
          break;
        }
      }
    } finally {
      breaker.endTask();
      if (this.currentBreaker === breaker) this.currentBreaker = undefined;
    }
    if (!done) {
      // Daemon stopping: don't quarantine, just hand back to the shutdown path.
      if (this.abortController.signal.aborted) return false;
      // Loop exhausted without done and without a trip (e.g. executor stopped
      // returning): treat as a turn-ceiling trip.
      await this.quarantineTask(task, 'turn_ceiling');
      return false;
    }
    return true;
  }

  /**
   * VERIFY: verification pipeline (fail-closed when not configured). Returns
   * the pipeline outcome: PASS (with whether Stage 3 proved the fix),
   * REPAIR (diagnostics for the next IMPLEMENT round), or FAIL (the task was
   * quarantined here).
   */
  private async verifyTask(
    task: QueuedTask,
    worktree: string,
    repairRound = 0,
  ): Promise<{ outcome: VerificationOutcome; revertProof: boolean; diagnostics: string[] }> {
    this.transition('verify', task.taskId);
    if (!this.verifier) {
      this.store.recordStep(task.taskId, {
        phase: 'verify',
        errorSignature: 'verification failed: no verification pipeline configured',
      });
      await this.releaseWorktree(task);
      this.transition('idle', task.taskId);
      return { outcome: 'FAIL', revertProof: false, diagnostics: ['no verification pipeline'] };
    }
    const kind = FINDING_KIND_TO_VERIFICATION_KIND[findingKindOf(task)];
    const verificationTask: {
      id: string;
      title: string;
      kind: VerificationTaskKind;
      finding?: string;
    } = {
      id: task.taskId,
      title: `${task.sourceCollector}:${task.fingerprint.slice(0, 12)}`,
      kind,
    };
    if (typeof task.findingPayload === 'string') {
      verificationTask.finding = task.findingPayload;
    }
    const result = await this.verifier.verify(verificationTask, worktree, { repairRound });
    this.store.recordStep(task.taskId, {
      phase: 'verify',
      errorSignature:
        `verification ${result.outcome} (round ${repairRound})` +
        (result.diagnostics.length > 0 ? `: ${result.diagnostics[0]}` : ''),
    });
    if (result.outcome === 'REPAIR') {
      // Not a failure yet: the caller sends the task back to IMPLEMENT with
      // these diagnostics as the repair nudge.
      return { outcome: 'REPAIR', revertProof: false, diagnostics: result.diagnostics };
    }
    if (result.outcome !== 'PASS') {
      // FAIL (after the pipeline's repair rounds): a genuine task failure.
      // Tombstone it so it is never silently stuck in VERIFYING and never
      // retried until the cooldown lapses.
      await this.quarantineTask(task, 'verify_failed');
      return { outcome: 'FAIL', revertProof: false, diagnostics: result.diagnostics };
    }
    if (result.bloatNeedsHumanReview) {
      // PASS still holds, but the daemon must not auto-merge a bloated diff.
      this.store.recordStep(task.taskId, {
        phase: 'verify',
        errorSignature: 'bloat cap tripped: needs human review, not auto-shipping',
      });
      await this.quarantineTask(task, 'verify_bloat');
      return { outcome: 'FAIL', revertProof: false, diagnostics: result.diagnostics };
    }
    const revertProof = result.stages.some((s) => s.stage === 3 && s.status === 'pass');
    return { outcome: 'PASS', revertProof, diagnostics: result.diagnostics };
  }

  /**
   * SHIP: shipping controller (fail-closed when not configured). Commits the
   * worktree first (the shipper pushes HEAD, so uncommitted edits would
   * never leave the machine), then ships. Returns the ship completion, or
   * undefined when the task did not ship.
   *
   * The three ship outcomes are handled explicitly — the old code treated
   * "no PR URL" as "not shipped" and returned undefined, which left the
   * task stuck in VERIFYING while the daemon moved on to the next task:
   * - merged / PR created: normal completion, `deliveryMode: 'auto'`.
   * - branch pushed but PR creation failed: the work IS shipped (branch on
   *   the remote, PR body on disk, review-queue entry written by the
   *   shipper). The task is marked done-with-caveat
   *   (`deliveryMode: 'auto:branch-only'`, branch + prBodyPath recorded in
   *   the step journal) so it never sits in VERIFYING and is never
   *   re-proposed — a human still has to open the PR by hand.
   * - branch push itself failed: nothing reached the remote. The task is
   *   quarantined (tombstoned, visible in `queue --include-tombstones`),
   *   not orphaned.
   * Every path records the task's terminal state durably (markDone /
   * tombstone) before this returns, so the daemon never picks up the next
   * task with the current one still unresolved.
   */
  private async shipTask(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    worktree: string,
    revertProof: boolean,
  ): Promise<ShipCompletion | undefined> {
    this.transition('ship', task.taskId);
    if (!this.shipper) {
      this.store.recordStep(task.taskId, {
        phase: 'ship',
        errorSignature: 'ship failed: no shipping controller configured',
      });
      await this.releaseWorktree(task);
      this.transition('idle', task.taskId);
      return undefined;
    }
    const baseSha = task.baseCommitSha ?? (await this.currentHead()) ?? 'HEAD';
    const stats = await collectChangeStats(worktree, baseSha);
    if (this.worktrees) {
      try {
        await this.worktrees.commit(
          task.taskId,
          `daemon: ${task.sourceCollector}:${task.fingerprint.slice(0, 12)}`,
        );
      } catch (err) {
        // Nothing to commit: verification passed on an empty diff (e.g. the
        // finding was already fixed). Nothing shippable — quarantine so the
        // task is visible and tombstoned instead of silently stuck.
        this.logger.warn(
          `[daemon] task ${task.taskId} has nothing to ship: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.quarantineTask(task, 'empty_diff');
        return undefined;
      }
    }
    const result = await this.shipper.ship({
      ...stats,
      category: FINDING_KIND_TO_CHANGE_CATEGORY[findingKindOf(task)],
      revertProof,
      taskId: task.taskId,
      worktreePath: worktree,
      baseSha,
      title: `${task.sourceCollector}:${task.fingerprint.slice(0, 12)}`,
      verificationReceipt: `verification: ${plan.verificationCommand}`,
    });
    // Shipped commit: the worktree HEAD at ship time (merge commit / PR head).
    const shippedCommitSha = (await this.currentHead(worktree)) ?? baseSha;
    this.store.recordStep(task.taskId, {
      phase: 'ship',
      errorSignature:
        `ship ${result.outcome} tier ${result.tier} risk ${result.riskScore} branch ${result.branch}` +
        (result.prUrl ? ` PR ${result.prUrl}` : '') +
        (result.prBodyPath ? ` pr-body ${result.prBodyPath}` : '') +
        (result.note ? ` (${result.note})` : ''),
    });
    switch (result.outcome) {
      case 'merged':
      case 'pr_created':
        return { shippedCommitSha, deliveryMode: 'auto', branch: result.branch };
      case 'branch_pushed_pr_failed':
        // Branch is on the remote and the review queue already holds the
        // entry; only the PR is missing. Done-with-caveat, not VERIFYING.
        this.logger.warn(
          `[daemon] task ${task.taskId} shipped branch ${result.branch} but no PR was opened` +
            (result.prBodyPath ? `; PR body at ${result.prBodyPath}` : '') +
            ' — marking done (branch-only)',
        );
        return {
          shippedCommitSha,
          deliveryMode: 'auto:branch-only',
          branch: result.branch,
          ...(result.prBodyPath ? { prBodyPath: result.prBodyPath } : {}),
        };
      case 'push_failed':
        // Nothing reached the remote; the PR body is on disk for a human.
        // Quarantine so the failure is visible instead of orphaned.
        await this.quarantineTask(
          task,
          `ship_push_failed: ${result.note ?? 'branch push failed'}`.slice(0, 500),
        );
        return undefined;
    }
  }

  /**
   * LEARN: ≤150-token episodic outcome to learned_patterns, then destroy the
   * task context, release the worktree, and mark the task done. The
   * delivery mode carries the ship caveat: a branch-only ship is done, but
   * the outcome text says so and names the branch and PR-body path.
   */
  private async learnTask(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    worktree: string,
    ship: ShipCompletion,
  ): Promise<void> {
    this.transition('learn', task.taskId);
    const shippedCommitSha = ship.shippedCommitSha;
    const caveat =
      ship.deliveryMode === 'auto:branch-only'
        ? ` Shipped branch-only on ${ship.branch} (no PR opened` +
          (ship.prBodyPath ? `; PR body at ${ship.prBodyPath}` : '') +
          ').'
        : '';
    const outcome = [
      `Task ${task.sourceCollector}:${task.fingerprint.slice(0, 12)} shipped.`,
      `Plan touched ${plan.filesToTouch.length} file(s); verification: ${plan.verificationCommand}.`,
      `Outcome: shipped as ${shippedCommitSha.slice(0, 12)}.${caveat}`,
    ].join(' ');
    // ≤150 tokens ≈ ≤600 chars (the store also caps the summary length).
    const capped = outcome.length > 600 ? `${outcome.slice(0, 597)}…` : outcome;
    this.store.recordPattern({
      scopeGlob: '**',
      patternType: 'INVARIANT',
      ruleSummary: capped,
      confidence: 0.7,
      createdFromTaskId: task.taskId,
    });
    const targetBlobHashes = await this.blobHashesForFiles(worktree, plan.filesToTouch);
    await Promise.resolve(this.executor?.disposeTaskContext?.(task.taskId)).catch(() => undefined);
    this.store.markDone(task.taskId, {
      shippedCommitSha,
      deliveryMode: ship.deliveryMode,
      targetBlobHashes,
    });
    await this.releaseWorktree(task);
    this.store.recordStep(task.taskId, { phase: 'learn', errorSignature: 'learned + done' });
    this.transition('idle', task.taskId);
    this.logger.log(
      `[daemon] task ${task.taskId} done (${worktree})` +
        (caveat ? ` — branch-only ship on ${ship.branch}` : ''),
    );
  }

  // -------------------------------------------------------------------------
  // Quarantine / helpers
  // -------------------------------------------------------------------------

  /**
   * Trip → quarantine: tombstone by fingerprint (the store's strike ladder
   * governs the cooldown), release the worktree, IDLE.
   */
  private async quarantineTask(
    task: QueuedTask,
    reason: string,
    trip?: CircuitTrip,
  ): Promise<void> {
    // The watchdog and the IMPLEMENT loop can both observe the same trip.
    if (this.quarantinedTaskIds.has(task.taskId)) return;
    this.quarantinedTaskIds.add(task.taskId);
    const treeHash = task.worktreePath ? await this.worktreeTreeHash(task.worktreePath) : undefined;
    try {
      const failure: {
        failureStage: DaemonState;
        failureReason: string;
        lastDiffHash?: string;
        targetBlobHashes: Record<string, string>;
      } = {
        failureStage: this.state,
        failureReason: trip ? `${reason}: ${trip.detail}` : reason,
        targetBlobHashes: task.worktreePath
          ? await this.blobHashesForFiles(task.worktreePath, task.targetFiles)
          : {},
      };
      if (treeHash !== undefined) failure.lastDiffHash = treeHash;
      this.store.tombstone({
        taskId: task.taskId,
        fingerprint: task.fingerprint,
        failure,
      });
    } catch (err) {
      this.logger.error(`[daemon] tombstone failed for ${task.taskId}: ${(err as Error).message}`);
    }
    const tombstone = this.store.getTombstone(task.fingerprint);
    try {
      this.store.recordStep(task.taskId, {
        phase: 'quarantine',
        errorSignature:
          `quarantined (strike ${tombstone?.strikeCount ?? '?'}, cooldown ` +
          `${tombstone?.cooldownUntilMs === -1 ? 'permanent' : 'until ' + String(tombstone?.cooldownUntilMs ?? '?')})` +
          `: ${reason}`,
      });
    } catch {
      // The tombstone already deleted the task row; the step may fail. Best effort.
    }
    await this.releaseWorktree(task).catch(() => undefined);
    this.transition('quarantine', task.taskId);
    this.transition('idle', task.taskId);
    this.logger.warn(`[daemon] task ${task.taskId} quarantined: ${reason}`);
  }

  private async releaseWorktree(task: QueuedTask): Promise<void> {
    if (this.worktrees) await this.worktrees.destroy(task.taskId);
    // Minimal stub (no worktree manager): work was done in place; nothing to release.
  }

  /** Blob SHAs of files in a worktree (done_set / tombstone target identity). */
  private async blobHashesForFiles(
    worktree: string,
    files: readonly string[],
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const file of files) {
      const result = await git(worktree, ['hash-object', '--', file], { allowFailure: true });
      if (result.exitCode === 0 && result.stdout.trim()) hashes[file] = result.stdout.trim();
    }
    return hashes;
  }

  /** `git write-tree` hash of a worktree; undefined when it is not a git tree. */
  private async worktreeTreeHash(worktree: string): Promise<string | undefined> {
    const result = await git(worktree, ['write-tree'], { allowFailure: true });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  private async currentHead(cwd: string = this.repoRoot): Promise<string | undefined> {
    const result = await git(cwd, ['rev-parse', 'HEAD'], { allowFailure: true });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  /** Sleep in headPollMs chunks; wake early when git HEAD changes. */
  private async sleepWithHeadWatch(totalMs: number): Promise<void> {
    let remaining = totalMs;
    while (remaining > 0 && !this.abortController.signal.aborted) {
      const chunk = Math.min(remaining, this.headPollMs);
      await this.clock.sleep(chunk, this.abortController.signal).catch(() => undefined);
      remaining -= chunk;
      // Control-file polling: a `pause` written while idling pauses at this
      // boundary; a `stop` aborts the loop. Cheap (one small JSON read per
      // chunk) and best-effort — an unreadable file just means "no intent".
      const action = this.readControlAction();
      if (action === 'pause') {
        this.pause();
        return;
      }
      if (action === 'stop') {
        this.abortController.abort(new Error('daemon stop requested via control file'));
        return;
      }
      const head = await this.currentHead();
      if (head !== undefined && this.lastHead !== undefined && head !== this.lastHead) {
        this.lastHead = head;
        this.emptyStreak = 0;
        this.logger.log('[daemon] new git HEAD detected, waking from IDLE');
        return;
      }
      if (head !== undefined) this.lastHead = head;
    }
  }

  /**
   * Latest operator intent from the control file (`daemon pause|resume|stop`
   * writes `{ action, ... }`), or null when no control path is configured or
   * the file is missing/unreadable. Never throws: polling must not kill the loop.
   */
  private readControlAction(): 'pause' | 'resume' | 'stop' | null {
    if (!this.controlPath) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.controlPath, 'utf8'));
      const action =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { action?: unknown }).action
          : undefined;
      return action === 'pause' || action === 'resume' || action === 'stop' ? action : null;
    } catch {
      return null;
    }
  }

  private transition(to: DaemonState, taskId?: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    const id = taskId ?? this.currentTask?.taskId;
    if (id) {
      const status = STATE_TO_TASK_STATUS[to];
      if (status) {
        try {
          this.store.updateTaskStatus(id, status);
        } catch {
          // Task may already be tombstoned/done (row deleted); transition anyway.
        }
      }
    }
    this.watchdog.noteProgress(id);
    this.onStateChange?.(from, to, id);
    this.logger.log(`[daemon] ${from} → ${to}${id ? ` (${id})` : ''}`);
  }
}
