import type { PriceConfig } from '../config/schema.js';
import { worstCaseUsd } from '../providers/pricing.js';

export type TaskCapKind = 'task_max_tokens' | 'task_max_usd';

export interface TaskCaps {
  /** Raw tokens (input + output, cache reads included) allowed for one task. */
  maxTokens?: number | undefined;
  /** Dollars allowed for one task. */
  maxUsd?: number | undefined;
  /** Warn once when either cap is this used (0..1). */
  warnAt: number;
}

export interface TaskSnapshot {
  taskId: string;
  tokens: number;
  usd: number;
  tokenFraction?: number;
  usdFraction?: number;
  /** The tightest cap's fraction; undefined when the task has no cap. */
  fraction?: number;
}

export interface TaskCheck {
  allowed: boolean;
  kind?: TaskCapKind;
  detail?: string;
  /** The call that crossed warnAt, so the caller can emit one warning. */
  warning?: { cap: 'tokens' | 'usd'; fraction: number };
}

export interface TaskSpend {
  taskId: string;
  tokens: number;
  usd: number;
}

/**
 * Per-task token and dollar caps. It is deliberately separate from the run-level budget: a run
 * can have money left while one runaway task is burning it. The supervisor asks `check` before
 * every call (pre-flight) and feeds `observe` after every billed call, so a task is parked before
 * it crosses 100%, never after.
 */
export class TaskGovernor {
  private taskId: string | undefined;
  private tokens = 0;
  private usd = 0;
  private warnedTokens = false;
  private warnedUsd = false;

  constructor(
    private readonly caps: TaskCaps,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.caps.maxTokens !== undefined || this.caps.maxUsd !== undefined;
  }

  /** Start a new task; spend from a previous task never counts against it. */
  begin(taskId: string | undefined): TaskSnapshot {
    if (taskId !== this.taskId) {
      this.taskId = taskId;
      this.tokens = 0;
      this.usd = 0;
      this.warnedTokens = false;
      this.warnedUsd = false;
    }
    return this.snapshot();
  }

  snapshot(taskId = this.taskId ?? 'unassigned'): TaskSnapshot {
    const tokenFraction =
      this.caps.maxTokens === undefined ? undefined : this.tokens / this.caps.maxTokens;
    const usdFraction = this.caps.maxUsd === undefined ? undefined : this.usd / this.caps.maxUsd;
    const fraction = Math.max(tokenFraction ?? 0, usdFraction ?? 0);
    return {
      taskId,
      tokens: this.tokens,
      usd: this.usd,
      ...(tokenFraction !== undefined ? { tokenFraction } : {}),
      ...(usdFraction !== undefined ? { usdFraction } : {}),
      ...(this.enabled ? { fraction } : {}),
    };
  }

  /**
   * Would the next call cross a task cap? `tokens` is the estimated prompt plus the output cap;
   * `price` prices that same worst case. A task switch starts fresh before the check.
   */
  check(input: {
    taskId?: string | undefined;
    promptTokens: number;
    maxOutputTokens: number;
    price: PriceConfig;
  }): TaskCheck {
    if (input.taskId !== undefined) this.begin(input.taskId);
    if (!this.enabled) return { allowed: true };
    const prompt = Number.isFinite(input.promptTokens) ? Math.max(0, input.promptTokens) : 0;
    const output = Number.isFinite(input.maxOutputTokens) ? Math.max(0, input.maxOutputTokens) : 0;
    const nextTokens = this.tokens + prompt + output;
    if (this.caps.maxTokens !== undefined && nextTokens > this.caps.maxTokens) {
      return {
        allowed: false,
        kind: 'task_max_tokens',
        detail: `task ${this.taskId ?? '?'} would reach ${String(nextTokens)} tokens (cap ${String(this.caps.maxTokens)})`,
      };
    }
    const worst = worstCaseUsd(prompt, output, input.price);
    if (this.caps.maxUsd !== undefined && this.usd + worst > this.caps.maxUsd) {
      return {
        allowed: false,
        kind: 'task_max_usd',
        detail: `task ${this.taskId ?? '?'} spent $${this.usd.toFixed(4)}; next call could reach $${(this.usd + worst).toFixed(4)} (cap $${this.caps.maxUsd})`,
      };
    }
    const tokenFraction = this.caps.maxTokens === undefined ? 0 : nextTokens / this.caps.maxTokens;
    const usdFraction = this.caps.maxUsd === undefined ? 0 : (this.usd + worst) / this.caps.maxUsd;
    const fraction = Math.max(tokenFraction, usdFraction);
    if (fraction >= this.caps.warnAt) {
      const cap = tokenFraction >= usdFraction ? 'tokens' : 'usd';
      const warned = cap === 'tokens' ? this.warnedTokens : this.warnedUsd;
      if (!warned) {
        if (cap === 'tokens') this.warnedTokens = true;
        else this.warnedUsd = true;
        return { allowed: true, warning: { cap, fraction } };
      }
    }
    return { allowed: true };
  }

  /** Account for one billed call and report the warning it just crossed. */
  observe(spend: TaskSpend): {
    warning?: { cap: 'tokens' | 'usd'; fraction: number };
    snapshot: TaskSnapshot;
  } {
    this.begin(spend.taskId);
    this.tokens += Math.max(0, spend.tokens);
    this.usd += Math.max(0, spend.usd);
    const snap = this.snapshot(spend.taskId);
    const tokenFraction = snap.tokenFraction ?? 0;
    const usdFraction = snap.usdFraction ?? 0;
    if (!this.warnedTokens && tokenFraction >= this.caps.warnAt) {
      this.warnedTokens = true;
      return {
        snapshot: snap,
        warning: { cap: 'tokens', fraction: tokenFraction },
      };
    }
    if (!this.warnedUsd && usdFraction >= this.caps.warnAt) {
      this.warnedUsd = true;
      return { snapshot: snap, warning: { cap: 'usd', fraction: usdFraction } };
    }
    return { snapshot: snap };
  }

  /** Record a task-level warning in the run feed once per cap. */
  warningKey(snapshot: TaskSnapshot, cap: 'tokens' | 'usd'): string {
    return `task:${snapshot.taskId}:${cap}`;
  }

  /** Timestamp helper kept injectable so tests can assert warning timing without sleeping. */
  timestamp(): number {
    return this.now();
  }
}
