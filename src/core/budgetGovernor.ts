import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, writeJsonAtomic } from './atomic.js';

/** Price per token for a model's input and output. */
export interface ModelPrices {
  input: number;
  output: number;
}

/** Maps a model name to its per-token input/output prices. */
export type PriceCard = Readonly<Record<string, ModelPrices>>;

/** Persistence backing store for the governor's cumulative spend. */
export interface BudgetStorage {
  load(): number;
  save(spent: number): void;
}

/** Options for constructing a {@link BudgetGovernor}. */
export interface BudgetGovernorOptions {
  storage: BudgetStorage;
  priceCard: PriceCard;
  sessionCap: number;
  /** Invoked when a call is blocked so the host can prompt the user. */
  onBlocked?: () => void;
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Interval between automatic persistence flushes (default: one minute). */
  persistIntervalMs?: number;
}

/**
 * A pre-flight budget governor: it estimates the cost of the next tool call and
 * blocks it when doing so would exceed the session cap. The cumulative spend is
 * persisted every minute so it survives restarts.
 */
export class BudgetGovernor {
  private readonly storage: BudgetStorage;
  private readonly priceCard: PriceCard;
  private readonly sessionCap: number;
  private readonly onBlocked: (() => void) | undefined;
  private readonly now: () => number;
  private readonly persistIntervalMs: number;
  private spent: number;
  private lastPersistedAt: number;

  constructor(options: BudgetGovernorOptions) {
    this.storage = options.storage;
    this.priceCard = options.priceCard;
    this.sessionCap = options.sessionCap;
    this.onBlocked = options.onBlocked;
    this.now = options.now ?? Date.now;
    this.persistIntervalMs = options.persistIntervalMs ?? 60_000;
    this.spent = this.storage.load();
    this.lastPersistedAt = this.now();
  }

  /**
   * Estimate the cost of the next call and decide whether it is allowed under
   * the session cap. When blocked, the blocked-prompt callback is invoked.
   */
  check(call: { promptTokens: number; outputTokens: number; model: string }): {
    allowed: boolean;
  } {
    const cost = this.estimateCost(call.promptTokens, call.outputTokens, call.model);
    if (this.spent + cost > this.sessionCap) {
      this.onBlocked?.();
      return { allowed: false };
    }
    this.spent += cost;
    this.maybePersist();
    return { allowed: true };
  }

  /** Force a persistence flush (e.g., before shutdown or for tests). */
  persist(): void {
    this.storage.save(this.spent);
    this.lastPersistedAt = this.now();
  }

  private estimateCost(promptTokens: number, outputTokens: number, model: string): number {
    const prices = this.priceCard[model];
    if (prices === undefined) return 0;
    return promptTokens * prices.input + outputTokens * prices.output;
  }

  private maybePersist(): void {
    if (this.now() - this.lastPersistedAt >= this.persistIntervalMs) {
      this.storage.save(this.spent);
      this.lastPersistedAt = this.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Budget governor v2: daemon buckets
// ---------------------------------------------------------------------------

/** One recorded model call (or a zero-cost SHIP marker) in the daemon ledger. */
export interface LedgerEntry {
  at: number;
  usd: number;
  tokens: number;
  taskId: string;
  /** True for the zero-cost marker a SHIP writes; resets the unproductive-spend clock. */
  shipped: boolean;
}

/** Persistence for the daemon's rolling spend ledger. */
export interface BudgetLedger {
  entries(): LedgerEntry[];
  record(entry: LedgerEntry): void;
}

/** In-memory ledger (tests, or a daemon that persists elsewhere). */
export class MemoryBudgetLedger implements BudgetLedger {
  private list: LedgerEntry[] = [];

  entries(): LedgerEntry[] {
    return [...this.list];
  }

  record(entry: LedgerEntry): void {
    this.list.push(entry);
  }
}

/**
 * JSON-file ledger under `.omnexx/` (default `budget_ledger.json`). There is no SQLite
 * state store in this repo, so per the daemon spec the ledger is a JSON file, not a
 * second SQLite wrapper; the shared table name `budget_ledger` is kept as the file stem
 * so a future SQLite migration can adopt it without renaming callers.
 */
export class JsonFileBudgetLedger implements BudgetLedger {
  constructor(private readonly path: string) {}

  entries(): LedgerEntry[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return (parsed as LedgerEntry[]).filter(
        (e) => Boolean(e) && typeof e.at === 'number' && typeof e.usd === 'number',
      );
    } catch {
      return [];
    }
  }

  record(entry: LedgerEntry): void {
    const all = [...this.entries(), entry];
    // Drop anything older than the longest window (24 h) plus an hour of slack.
    const cutoff = entry.at - 25 * 3_600_000;
    const kept = all.filter((e) => e.at > cutoff);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(kept)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }
}

export interface DaemonBudgetCaps {
  /** Per-task soft token cap; warns at `taskSoftWarnAt` of it. */
  taskSoftTokens: number;
  taskSoftWarnAt: number;
  /** Per-task hard caps; tripping aborts the task to QUARANTINE. */
  taskHardTokens: number;
  taskHardUsd: number;
  /** Rolling 1 h window caps; tripping suspends until the window frees. */
  hourTokens: number;
  hourUsd: number;
  /** Rolling 24 h window caps. */
  dayTokens: number;
  dayUsd: number;
  /** Consecutive spend with zero SHIPs that opens the global circuit breaker. */
  unproductiveUsd: number;
}

export const DEFAULT_DAEMON_CAPS: DaemonBudgetCaps = {
  taskSoftTokens: 120_000,
  taskSoftWarnAt: 0.8,
  taskHardTokens: 150_000,
  taskHardUsd: 0.5,
  hourTokens: 1_000_000,
  hourUsd: 3.0,
  dayTokens: 10_000_000,
  dayUsd: 25.0,
  unproductiveUsd: 2.5,
};

export type BudgetEventType =
  'SOFT_CAP_WARNING' | 'TASK_CAP_TRIP' | 'WINDOW_CAP_PAUSE' | 'CIRCUIT_BREAKER_TRIP';

export interface BudgetEvent {
  type: BudgetEventType;
  taskId?: string | undefined;
  detail: string;
  /** When a paused window frees (WINDOW_CAP_PAUSE only). */
  resumeAt?: number | undefined;
}

export type BudgetAction = 'QUARANTINE' | 'BUDGET_PAUSE' | 'CIRCUIT_BREAKER';

export interface UsageDecision {
  allowed: boolean;
  /** Machine code for the abort path (e.g. `BUDGET_TASK_EXCEEDED`). */
  code?: string | undefined;
  action?: BudgetAction | undefined;
  resumeAt?: number | undefined;
  detail?: string | undefined;
}

export interface DaemonBudgetGovernorOptions {
  ledger: BudgetLedger;
  priceCard: PriceCard;
  caps?: Partial<DaemonBudgetCaps>;
  onEvent?: (event: BudgetEvent) => void;
  now?: () => number;
}

/** Frozen task context written by {@link DaemonBudgetGovernor.freezeTask}. */
export interface FrozenContext {
  taskId: string;
  /** `refs/omnexx/wip/<task-id>` commit the worktree was checkpointed to. */
  commit: string;
  /** Compacted message array, restored verbatim on thaw. */
  messages: unknown[];
  stepCursor: number;
  frozenAt: number;
  status: 'PAUSED_BUDGET';
}

/** Grace for the in-flight tool call to finish before a freeze checkpoints. */
export const FREEZE_GRACE_MS = 15_000;

/**
 * Four concurrent buckets over one ledger: per-task soft/hard, rolling hour, rolling day,
 * plus the unproductive-spend circuit breaker. The single-session `BudgetGovernor.check()`
 * above is untouched; this class is the daemon's governor and shares its price card.
 */
export class DaemonBudgetGovernor {
  private readonly ledger: BudgetLedger;
  private readonly priceCard: PriceCard;
  private readonly caps: DaemonBudgetCaps;
  private readonly onEvent: ((event: BudgetEvent) => void) | undefined;
  private readonly now: () => number;
  private circuitOpen = false;
  private readonly pausedUntil = new Map<string, number>();

  constructor(options: DaemonBudgetGovernorOptions) {
    this.ledger = options.ledger;
    this.priceCard = options.priceCard;
    this.caps = { ...DEFAULT_DAEMON_CAPS, ...options.caps };
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
  }

  /** Spend for one task (all time in the ledger). */
  taskUsage(taskId: string): { tokens: number; usd: number } {
    return this.ledger.entries().reduce(
      (s, e) => {
        if (e.taskId !== taskId || e.shipped) return s;
        return { tokens: s.tokens + e.tokens, usd: s.usd + e.usd };
      },
      { tokens: 0, usd: 0 },
    );
  }

  /** Spend in the rolling hour and day windows. */
  windowUsage(now: number = this.now()): {
    hourTokens: number;
    hourUsd: number;
    dayTokens: number;
    dayUsd: number;
  } {
    const entries = this.ledger.entries();
    const sum = (windowMs: number): { tokens: number; usd: number } =>
      entries.reduce(
        (s, e) => {
          if (e.at <= now - windowMs || e.shipped) return s;
          return { tokens: s.tokens + e.tokens, usd: s.usd + e.usd };
        },
        { tokens: 0, usd: 0 },
      );
    const hour = sum(3_600_000);
    const day = sum(24 * 3_600_000);
    return { hourTokens: hour.tokens, hourUsd: hour.usd, dayTokens: day.tokens, dayUsd: day.usd };
  }

  /** Consecutive spend since the last SHIP marker. */
  unproductiveSpend(): number {
    const entries = this.ledger.entries();
    let sum = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined) break;
      if (e.shipped) break;
      sum += e.usd;
    }
    return sum;
  }

  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** Human inspection is done; close the breaker so tasks may run again. */
  resetCircuitBreaker(): void {
    this.circuitOpen = false;
  }

  /** Record a SHIP: resets the unproductive-spend clock. */
  recordShip(taskId: string): void {
    this.ledger.record({ at: this.now(), usd: 0, tokens: 0, taskId, shipped: true });
  }

  /**
   * Pre-flight check for the next model call, then record it when allowed. Returns the
   * abort action the daemon must take when blocked (`QUARANTINE` on a task-cap trip,
   * `BUDGET_PAUSE` on a window trip, `CIRCUIT_BREAKER` on unproductive spend).
   */
  recordUsage(
    taskId: string,
    call: { promptTokens: number; outputTokens: number; model: string },
  ): UsageDecision {
    const now = this.now();
    if (this.circuitOpen) {
      return {
        allowed: false,
        code: 'BUDGET_CIRCUIT_BREAKER',
        action: 'CIRCUIT_BREAKER',
        detail: 'global circuit breaker open: unproductive spend with zero SHIPs',
      };
    }
    const paused = this.pausedUntil.get(taskId);
    if (paused !== undefined && now < paused) {
      return {
        allowed: false,
        code: 'BUDGET_PAUSED',
        action: 'BUDGET_PAUSE',
        resumeAt: paused,
        detail: `task paused until ${new Date(paused).toISOString()}`,
      };
    }
    if (paused !== undefined) this.pausedUntil.delete(taskId);

    const cost = this.estimateCost(call.promptTokens, call.outputTokens, call.model);
    const tokens = call.promptTokens + call.outputTokens;
    const task = this.taskUsage(taskId);

    if (
      task.tokens + tokens > this.caps.taskHardTokens ||
      task.usd + cost > this.caps.taskHardUsd
    ) {
      this.emit({
        type: 'TASK_CAP_TRIP',
        taskId,
        detail: `task ${taskId} hit the hard cap (${task.tokens + tokens} tokens / $${(task.usd + cost).toFixed(4)})`,
      });
      return {
        allowed: false,
        code: 'BUDGET_TASK_EXCEEDED',
        action: 'QUARANTINE',
        detail: `per-task hard cap exceeded (${this.caps.taskHardTokens} tokens / $${this.caps.taskHardUsd})`,
      };
    }

    const windows = this.windowUsage(now);
    const hourTrip =
      windows.hourTokens + tokens > this.caps.hourTokens ||
      windows.hourUsd + cost > this.caps.hourUsd;
    const dayTrip =
      windows.dayTokens + tokens > this.caps.dayTokens || windows.dayUsd + cost > this.caps.dayUsd;
    if (hourTrip || dayTrip) {
      const windowMs = hourTrip ? 3_600_000 : 24 * 3_600_000;
      const resumeAt = this.windowRollsAt(
        windowMs,
        hourTrip
          ? { tokens: this.caps.hourTokens, usd: this.caps.hourUsd }
          : { tokens: this.caps.dayTokens, usd: this.caps.dayUsd },
        now,
      );
      this.pausedUntil.set(taskId, resumeAt);
      this.emit({
        type: 'WINDOW_CAP_PAUSE',
        taskId,
        detail: `${hourTrip ? 'hourly' : 'daily'} window cap reached`,
        resumeAt,
      });
      return {
        allowed: false,
        code: 'BUDGET_WINDOW_EXCEEDED',
        action: 'BUDGET_PAUSE',
        resumeAt,
        detail: `${hourTrip ? 'hourly' : 'daily'} rolling window cap reached; resumes ${new Date(resumeAt).toISOString()}`,
      };
    }

    this.ledger.record({ at: now, usd: cost, tokens, taskId, shipped: false });

    if (task.tokens + tokens >= this.caps.taskSoftTokens * this.caps.taskSoftWarnAt) {
      this.emit({
        type: 'SOFT_CAP_WARNING',
        taskId,
        detail: `task ${taskId} at ${task.tokens + tokens} / ${this.caps.taskSoftTokens} soft-cap tokens`,
      });
    }
    if (this.unproductiveSpend() >= this.caps.unproductiveUsd) {
      this.circuitOpen = true;
      this.emit({
        type: 'CIRCUIT_BREAKER_TRIP',
        detail: `$${this.unproductiveSpend().toFixed(2)} spent with zero SHIPs; pausing for human inspection`,
      });
    }
    return { allowed: true };
  }

  /**
   * Mid-task freeze: wait for the in-flight tool call (15 s grace), checkpoint the
   * worktree via the injected `checkpoint()`, then serialize the compacted messages +
   * step cursor to `contextPath`. The task resumes from {@link thawTask} exactly.
   */
  async freezeTask(
    taskId: string,
    opts: {
      messages: unknown[];
      stepCursor: number;
      contextPath: string;
      checkpoint: () => Promise<string>;
      waitForCurrentCall?: () => Promise<void>;
    },
  ): Promise<FrozenContext> {
    if (opts.waitForCurrentCall) {
      await Promise.race([
        opts.waitForCurrentCall(),
        new Promise<void>((resolve) => setTimeout(resolve, FREEZE_GRACE_MS)),
      ]);
    }
    const commit = await opts.checkpoint();
    const frozen: FrozenContext = {
      taskId,
      commit,
      messages: opts.messages,
      stepCursor: opts.stepCursor,
      frozenAt: this.now(),
      status: 'PAUSED_BUDGET',
    };
    await writeJsonAtomic(opts.contextPath, frozen);
    return frozen;
  }

  /** Restore a frozen context exactly as {@link freezeTask} wrote it. */
  async thawTask(taskId: string, contextPath: string): Promise<FrozenContext> {
    const frozen = (await readJson(contextPath)) as Record<string, unknown>;
    if (frozen.taskId !== taskId || frozen.status !== 'PAUSED_BUDGET') {
      throw new Error(`no PAUSED_BUDGET context for ${taskId} at ${contextPath}`);
    }
    this.pausedUntil.delete(taskId);
    return frozen as unknown as FrozenContext;
  }

  /**
   * When the rolling window's spend will have dropped to the caps: the moment the oldest
   * entries that must expire fall out of the window. Returns `now` if already under.
   */
  private windowRollsAt(
    windowMs: number,
    target: { tokens: number; usd: number },
    now: number,
  ): number {
    const inWindow = this.ledger
      .entries()
      .filter((e) => e.at > now - windowMs && !e.shipped)
      .sort((a, b) => a.at - b.at);
    let tokens = inWindow.reduce((s, e) => s + e.tokens, 0);
    let usd = inWindow.reduce((s, e) => s + e.usd, 0);
    for (const e of inWindow) {
      if (tokens <= target.tokens && usd <= target.usd) break;
      tokens -= e.tokens;
      usd -= e.usd;
      if (tokens <= target.tokens && usd <= target.usd) return e.at + windowMs;
    }
    return now;
  }

  private emit(event: BudgetEvent): void {
    this.onEvent?.(event);
  }

  private estimateCost(promptTokens: number, outputTokens: number, model: string): number {
    const prices = this.priceCard[model];
    if (prices === undefined) return 0;
    return promptTokens * prices.input + outputTokens * prices.output;
  }
}

/** Default freeze/thaw context path for a task: `.omnexx/wip/<task-id>.context.json`. */
export const daemonContextPath = (repoRoot: string, taskId: string): string =>
  `${repoRoot}/.omnexx/wip/${taskId}.context.json`;
