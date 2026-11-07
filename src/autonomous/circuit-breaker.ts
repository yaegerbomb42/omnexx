/**
 * TaskCircuitBreaker + WatchdogMonitor for the 24/7 Autonomous Development Daemon.
 *
 * The breaker is evaluated after every turn / tool call inside IMPLEMENT and trips the
 * task into QUARANTINE before a stuck loop can burn tokens or corrupt the worktree.
 * The watchdog is an independent wall-clock timer: if the daemon makes no state
 * progress for 300s it aborts the cycle, SIGKILLs the child process group, quarantines
 * the task and forces the daemon back to IDLE.
 *
 * Error-streak logic is ported from `src/core/doom-loop-ratchet.ts` (normalize +
 * sha256 signature); it is imported, not rewritten.
 */
import { createHash } from 'node:crypto';
import { hashErrorSignature, normalizeErrorSignature } from '../core/doom-loop-ratchet.js';
import { cooldownUntilForStrike } from './state-store.js';

export type CircuitTripReason =
  'turn_ceiling' | 'wall_clock_lease' | 'identical_tool_errors' | 'tree_cycle' | 'read_stall';

export interface CircuitTrip {
  reason: CircuitTripReason;
  detail: string;
  turn: number;
  /** The normalized error signature that tripped the breaker, when applicable. */
  errorHash?: string;
}

export interface CircuitBreakerOptions {
  /** Max turns per task (IMPLEMENT loop ceiling). Default 50. */
  maxTurnsPerTask?: number;
  /** Max wall-clock seconds per task lease. Default 1800 (30 min). */
  maxWallClockSec?: number;
  /** Consecutive identical tool errors that trip. Default 3. */
  maxConsecutiveIdenticalErrors?: number;
  /** Total identical tool errors (non-consecutive) that trip. Default 4. */
  maxTotalIdenticalErrors?: number;
  /** Prior tree hashes kept for the cycle window. Default 6. */
  treeCycleWindow?: number;
  /** Consecutive read/search turns without mutation that trip. Default 6. */
  readStallTurns?: number;
  /** Read-only turn count at which a nudge is issued before the trip. Default 5. */
  readStallNudgeTurn?: number;
  /** Time source; defaults to Date.now. */
  now?: () => number;
  /** Called exactly once when the breaker trips. */
  onTrip?: (trip: CircuitTrip) => void | Promise<void>;
}

/** A single tool-call outcome the breaker evaluates. */
export interface TurnOutcome {
  /** True when the task's goal is complete after this turn. */
  done?: boolean | undefined;
  /** Name of the tool that ran this turn, if any. */
  toolName?: string | undefined;
  /** Summary of the tool input (used as part of the error signature context). */
  inputSummary?: string | undefined;
  /** True when the turn only read/searched and mutated nothing. */
  isReadOnly: boolean;
  /** stderr/stdout of a failed tool call, when the turn errored. */
  errorContent?: string | undefined;
  /** `git write-tree` hash of the worktree after this turn, when a mutation happened. */
  treeHash?: string | undefined;
}

export interface TurnEvaluation {
  /** Set when this turn tripped the breaker. */
  trip?: CircuitTrip | undefined;
  /** Set on the nudge turn (read-only turn 5) so the agent can course-correct. */
  nudge?: string | undefined;
}

/**
 * sha256 of tool_name + the first 3 stderr lines, after normalization strips line
 * numbers, timestamps, addresses and durations — so the same failure recurring with
 * different line numbers still counts as identical.
 */
export function hashToolError(toolName: string, errorContent: string): string {
  const firstLines = errorContent.split('\n').slice(0, 3).join('\n');
  const normalized = normalizeErrorSignature(firstLines);
  return createHash('sha256').update(`${toolName}::${normalized}`).digest('hex').slice(0, 16);
}

export class TaskCircuitBreaker {
  private readonly maxTurnsPerTask: number;
  private readonly maxWallClockSec: number;
  private readonly maxConsecutiveIdenticalErrors: number;
  private readonly maxTotalIdenticalErrors: number;
  private readonly treeCycleWindow: number;
  private readonly readStallTurns: number;
  private readonly readStallNudgeTurn: number;
  private readonly now: () => number;
  private readonly onTrip: ((trip: CircuitTrip) => void | Promise<void>) | undefined;

  private readonly abortController = new AbortController();
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAtMs = 0;
  private turn = 0;

  /** Per-error-hash: { consecutive, total }. */
  private readonly errorCounts = new Map<string, { consecutive: number; total: number }>();
  private lastErrorHash = '';
  /** Prior tree hashes, newest last; capped at treeCycleWindow. */
  private readonly treeHashes: string[] = [];
  private consecutiveReadOnlyTurns = 0;
  private tripped: CircuitTrip | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.maxTurnsPerTask = options.maxTurnsPerTask ?? 25;
    this.maxWallClockSec = options.maxWallClockSec ?? 1800;
    this.maxConsecutiveIdenticalErrors = options.maxConsecutiveIdenticalErrors ?? 3;
    this.maxTotalIdenticalErrors = options.maxTotalIdenticalErrors ?? 4;
    this.treeCycleWindow = options.treeCycleWindow ?? 6;
    this.readStallTurns = options.readStallTurns ?? 6;
    this.readStallNudgeTurn = options.readStallNudgeTurn ?? 5;
    this.now = options.now ?? Date.now;
    this.onTrip = options.onTrip;
  }

  /** AbortSignal the task's work is cancelled through when the lease expires or a trip fires. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get currentTurn(): number {
    return this.turn;
  }

  get trip(): CircuitTrip | undefined {
    return this.tripped;
  }

  get isTripped(): boolean {
    return this.tripped !== undefined;
  }

  /** Start the wall-clock lease for a task; arms the AbortController deadline. */
  beginTask(): void {
    this.startedAtMs = this.now();
    this.turn = 0;
    this.tripped = undefined;
    this.errorCounts.clear();
    this.lastErrorHash = '';
    this.treeHashes.length = 0;
    this.consecutiveReadOnlyTurns = 0;
    this.clearLeaseTimer();
    this.leaseTimer = setTimeout(() => {
      this.tripBreaker({
        reason: 'wall_clock_lease',
        detail: `task exceeded wall-clock lease of ${this.maxWallClockSec}s`,
        turn: this.turn,
      });
    }, this.maxWallClockSec * 1000);
    // The daemon's own loop keeps the process alive; the timer must not.
    this.leaseTimer.unref();
  }

  /** End the lease cleanly (task finished or was handed off); aborts nothing. */
  endTask(): void {
    this.clearLeaseTimer();
  }

  /**
   * Evaluate one completed turn. Call after every turn / tool call in IMPLEMENT.
   * Returns a trip (stop the task) and/or a nudge (warn the agent, keep going).
   * The wall-clock lease is checked first; the turn ceiling is checked last and
   * skipped when the turn finished the task, so a task completing exactly on its
   * 25th turn ships instead of tripping.
   */
  evaluateTurn(outcome: TurnOutcome): TurnEvaluation {
    if (this.tripped) return { trip: this.tripped };
    this.turn++;

    const lease = this.checkWallClock();
    if (lease) return { trip: lease };

    if (outcome.errorContent && outcome.toolName) {
      const trip = this.recordToolFailure(
        outcome.toolName,
        outcome.inputSummary ?? '',
        outcome.errorContent,
      );
      if (trip) return { trip };
    } else {
      this.recordToolSuccess();
    }

    if (outcome.treeHash) {
      const trip = this.recordTreeHash(outcome.treeHash);
      if (trip) return { trip };
    }

    const stall = this.recordReadOnlyTurn(outcome.isReadOnly);
    if (stall.trip) return { trip: stall.trip };
    const nudge = stall.nudge;

    if (!outcome.done) {
      const ceiling = this.checkTurnCeiling();
      if (ceiling) return { trip: ceiling };
    }

    return nudge ? { nudge } : {};
  }

  /** Turn ceiling: max_turns_per_task. */
  checkTurnCeiling(): CircuitTrip | undefined {
    if (this.turn >= this.maxTurnsPerTask) {
      return this.tripBreaker({
        reason: 'turn_ceiling',
        detail: `task exceeded max_turns_per_task=${this.maxTurnsPerTask}`,
        turn: this.turn,
      });
    }
    return undefined;
  }

  /** Wall-clock lease check (the lease timer also fires this on its own). */
  checkWallClock(): CircuitTrip | undefined {
    if (this.startedAtMs === 0) return undefined;
    const elapsedSec = (this.now() - this.startedAtMs) / 1000;
    if (elapsedSec > this.maxWallClockSec) {
      return this.tripBreaker({
        reason: 'wall_clock_lease',
        detail: `task exceeded wall-clock lease of ${this.maxWallClockSec}s (elapsed ${elapsedSec.toFixed(0)}s)`,
        turn: this.turn,
      });
    }
    return undefined;
  }

  /**
   * Identical-tool-error streak. Trips on `maxConsecutiveIdenticalErrors` consecutive
   * identical errors, or `maxTotalIdenticalErrors` total identical errors.
   */
  recordToolFailure(
    toolName: string,
    _inputSummary: string,
    errorContent: string,
  ): CircuitTrip | undefined {
    // doom-loop-ratchet hashes the full normalized error with the tool+input context;
    // the breaker hashes tool_name + the first 3 stderr lines, per the daemon spec.
    const { hash } = hashErrorSignature(errorContent.split('\n').slice(0, 3).join('\n'), toolName);
    const counts = this.errorCounts.get(hash) ?? { consecutive: 0, total: 0 };
    counts.total++;
    counts.consecutive = hash === this.lastErrorHash ? counts.consecutive + 1 : 1;
    this.errorCounts.set(hash, counts);
    this.lastErrorHash = hash;

    if (
      counts.consecutive >= this.maxConsecutiveIdenticalErrors ||
      counts.total >= this.maxTotalIdenticalErrors
    ) {
      return this.tripBreaker({
        reason: 'identical_tool_errors',
        detail:
          `identical tool error "${toolName}" ` +
          `(${counts.consecutive} consecutive, ${counts.total} total; hash ${hash})`,
        turn: this.turn,
        errorHash: hash,
      });
    }
    return undefined;
  }

  recordToolSuccess(): void {
    this.lastErrorHash = '';
    for (const counts of this.errorCounts.values()) counts.consecutive = 0;
  }

  /**
   * Tree-hash cycle: after each file mutation, if the new `git write-tree` hash
   * matches any prior hash in the window, the agent is oscillating (edit → revert →
   * edit) and the task trips.
   */
  recordTreeHash(treeHash: string): CircuitTrip | undefined {
    if (this.treeHashes.includes(treeHash)) {
      return this.tripBreaker({
        reason: 'tree_cycle',
        detail: `worktree tree hash ${treeHash} repeated within a window of ${this.treeCycleWindow} mutations`,
        turn: this.turn,
      });
    }
    this.treeHashes.push(treeHash);
    if (this.treeHashes.length > this.treeCycleWindow) this.treeHashes.shift();
    return undefined;
  }

  /**
   * Read-only stall: consecutive read/search turns without mutation. Nudge on the
   * `readStallNudgeTurn`-th turn, trip on the `readStallTurns`-th.
   */
  recordReadOnlyTurn(isReadOnly: boolean): { nudge?: string; trip?: CircuitTrip } {
    if (!isReadOnly) {
      this.consecutiveReadOnlyTurns = 0;
      return {};
    }
    this.consecutiveReadOnlyTurns++;
    if (this.consecutiveReadOnlyTurns >= this.readStallTurns) {
      return {
        trip: this.tripBreaker({
          reason: 'read_stall',
          detail: `${this.consecutiveReadOnlyTurns} consecutive read/search turns without mutation`,
          turn: this.turn,
        }),
      };
    }
    if (this.consecutiveReadOnlyTurns === this.readStallNudgeTurn) {
      return {
        nudge:
          `Nudge: ${this.consecutiveReadOnlyTurns} consecutive read-only turns. ` +
          `Make a mutation or propose a concrete next edit — one more read-only turn trips the circuit breaker.`,
      };
    }
    return {};
  }

  /** Abort the task's work (lease expiry, trip, or daemon shutdown). */
  abort(reason?: string): void {
    this.clearLeaseTimer();
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error(reason ?? 'task circuit breaker aborted'));
    }
  }

  private tripBreaker(trip: CircuitTrip): CircuitTrip {
    if (!this.tripped) {
      this.tripped = trip;
      void this.onTrip?.(trip);
    }
    this.abort(`circuit breaker tripped: ${trip.reason} — ${trip.detail}`);
    return this.tripped;
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

/**
 * Tombstone cooldowns, by strike count on the same target.
 *
 * Single source of truth is the state store's ladder
 * (`TOMBSTONE_COOLDOWNS_MS` in state-store.ts): strike 1 = 1h, 2 = 6h,
 * 3 = 24h, 4 = 7 days, 5+ = permanent (-1) until the target blob SHA
 * changes. The daemon persists tombstones via `store.tombstone()`, which
 * uses that ladder; this function mirrors it for in-memory reporting.
 */
export function tombstoneCooldownMs(strikes: number): number {
  // cooldownUntilForStrike(strike, 0) returns the duration itself.
  return cooldownUntilForStrike(Math.max(strikes, 1), 0);
}

export interface Tombstone {
  taskId: string;
  targetBlobSha?: string | undefined;
  strikes: number;
  /** ms until the tombstone lifts; -1 = permanent until target blob SHA changes. */
  cooldownMs: number;
  tombstonedUntilMs: number | undefined;
  reason: string;
}

export function makeTombstone(
  taskId: string,
  strikes: number,
  reason: string,
  targetBlobSha?: string,
  nowMs: number = Date.now(),
): Tombstone {
  const cooldownMs = tombstoneCooldownMs(strikes);
  return {
    taskId,
    targetBlobSha,
    strikes,
    cooldownMs,
    tombstonedUntilMs: cooldownMs === -1 ? undefined : nowMs + cooldownMs,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** How often to check for progress. Default 30_000 ms. */
  intervalMs?: number;
  /** No state progress for this long triggers the stall path. Default 900_000 ms (15 min). */
  stallMs?: number;
  /** Time source (wall clock); defaults to Date.now. */
  now?: () => number;
  /** Kill a child process group by pgid; defaults to process.kill(-pgid, 'SIGKILL'). */
  killProcessGroup?: (pgid: number) => void;
  /**
   * Called when the daemon stalls: abort the cycle, SIGKILL the child process group,
   * quarantine the task, force IDLE. The monitor already killed the registered pgid
   * (if any) before invoking this.
   */
  onStall: (info: { taskId: string | undefined; stalledForMs: number }) => void | Promise<void>;
}

export const defaultKillProcessGroup = (pgid: number): void => {
  try {
    // Negative pid = the whole process group.
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already dead or no permission: the stall handler quarantines regardless.
  }
};

/**
 * Independent wall-clock timer. Any state progress (a transition, a recorded step)
 * resets the clock via noteProgress(); silence for `stallMs` aborts the cycle.
 * `checkStall(now)` is public so tests can drive it without waiting on the timer.
 */
export class WatchdogMonitor {
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly now: () => number;
  private readonly killProcessGroup: (pgid: number) => void;
  private readonly onStall: WatchdogOptions['onStall'];

  private timer: ReturnType<typeof setInterval> | undefined;
  private lastProgressMs: number;
  private currentTaskId: string | undefined;
  private currentPgid: number | undefined;
  private stalling = false;

  constructor(options: WatchdogOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.stallMs = options.stallMs ?? 900_000;
    this.now = options.now ?? Date.now;
    this.killProcessGroup = options.killProcessGroup ?? defaultKillProcessGroup;
    this.onStall = options.onStall;
    this.lastProgressMs = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastProgressMs = this.now();
    this.timer = setInterval(() => {
      this.checkStall(this.now()).catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Call on every state transition / recorded step: the daemon is alive. */
  noteProgress(taskId?: string): void {
    this.lastProgressMs = this.now();
    this.stalling = false;
    if (taskId !== undefined) this.currentTaskId = taskId;
  }

  /** Register the child process group the current task's work runs in. */
  registerChildProcessGroup(pgid: number | undefined, taskId?: string): void {
    this.currentPgid = pgid;
    if (taskId !== undefined) this.currentTaskId = taskId;
  }

  clearTask(): void {
    this.currentTaskId = undefined;
    this.currentPgid = undefined;
  }

  get stalledForMs(): number {
    return this.now() - this.lastProgressMs;
  }

  /** Check once; returns true when a stall was handled. */
  async checkStall(nowMs: number): Promise<boolean> {
    const stalledFor = nowMs - this.lastProgressMs;
    if (stalledFor < this.stallMs || this.stalling) return false;
    this.stalling = true;
    if (this.currentPgid !== undefined) this.killProcessGroup(this.currentPgid);
    await this.onStall({ taskId: this.currentTaskId, stalledForMs: stalledFor });
    this.lastProgressMs = nowMs;
    this.stalling = false;
    return true;
  }
}
