import type { OmnexxConfig, PriceConfig } from '../config/schema.js';
import { worstCaseUsd } from '../providers/pricing.js';

export type BudgetStop =
  'max_usd' | 'max_usd_per_day' | 'max_turns_per_cycle' | 'max_tokens_per_cycle';

export interface CycleUsage {
  turns: number;
  /** Input + output tokens of every call this cycle, before cache discounts. */
  tokens: number;
}

export interface PreflightInput {
  /** Spend in the rolling 24 h window, for the daily cap. */
  spentTodayUsd?: number;
  spentUsd: number;
  cycle: CycleUsage;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  price: PriceConfig;
}

export type PreflightResult =
  { ok: true; worstCaseUsd: number } | { ok: false; stop: BudgetStop; detail: string };

/**
 * Before every model call (plan §3.11): would the worst case for this one call cross a cap?
 * If so, the cycle ends gracefully instead of making the call, so spend never overshoots by
 * more than one turn's estimation error.
 */
export function preflight(budget: OmnexxConfig['budget'], i: PreflightInput): PreflightResult {
  const worst = worstCaseUsd(i.estimatedInputTokens, i.maxOutputTokens, i.price);
  if (i.cycle.turns >= budget.max_turns_per_cycle) {
    return {
      ok: false,
      stop: 'max_turns_per_cycle',
      detail: `${i.cycle.turns} turns used this cycle`,
    };
  }
  const tokens = i.cycle.tokens + i.estimatedInputTokens + i.maxOutputTokens;
  if (tokens > budget.max_tokens_per_cycle) {
    return {
      ok: false,
      stop: 'max_tokens_per_cycle',
      detail: `next call could bring the cycle to ${tokens} tokens`,
    };
  }
  if (i.spentUsd + worst > budget.max_usd) {
    return {
      ok: false,
      stop: 'max_usd',
      detail: `$${i.spentUsd.toFixed(4)} spent; next call could cost up to $${worst.toFixed(4)} (cap $${budget.max_usd})`,
    };
  }
  if (i.spentTodayUsd !== undefined && i.spentTodayUsd + worst > budget.max_usd_per_day) {
    return {
      ok: false,
      stop: 'max_usd_per_day',
      detail: `${i.spentTodayUsd.toFixed(4)} spent in the last 24 h; next call could cost up to ${worst.toFixed(4)} (daily cap ${budget.max_usd_per_day})`,
    };
  }
  return { ok: true, worstCaseUsd: worst };
}

export interface SpendEntry {
  at: number;
  usd: number;
}

export const DAY_MS = 24 * 3_600_000;

/** Spend in the rolling 24 h window ending at `now`. */
export function spentInWindow(ledger: readonly SpendEntry[], now: number): number {
  return ledger.reduce((sum, e) => (e.at > now - DAY_MS ? sum + e.usd : sum), 0);
}

/**
 * When the rolling-window spend will have dropped to `target` or below: the moment the oldest
 * entries that must expire fall out of the window. Returns `now` if it already has.
 */
export function windowRollsAt(ledger: readonly SpendEntry[], now: number, target: number): number {
  const inWindow = ledger.filter((e) => e.at > now - DAY_MS).sort((a, b) => a.at - b.at);
  let sum = inWindow.reduce((s, e) => s + e.usd, 0);
  for (const e of inWindow) {
    if (sum <= target) break;
    sum -= e.usd;
    if (sum <= target) return e.at + DAY_MS;
  }
  return now;
}

/** Pause below the daily cap with headroom for at least one more call. */
export const dailyPauseThreshold = (budget: OmnexxConfig['budget']): number =>
  budget.max_usd_per_day * 0.9;

export interface RunLimits {
  spentUsd: number;
  elapsedMs: number;
  cycles: number;
}

export interface RunLimitHit {
  kind: 'max_usd' | 'max_hours' | 'max_cycles';
  detail: string;
}

/** Run-level caps checked at cycle boundaries. Hitting one stops the run with exit code 3. */
export function runLimitHit(budget: OmnexxConfig['budget'], r: RunLimits): RunLimitHit | undefined {
  if (r.spentUsd >= budget.max_usd)
    return { kind: 'max_usd', detail: `$${r.spentUsd.toFixed(2)} of $${budget.max_usd}` };
  if (r.elapsedMs >= budget.max_hours * 3_600_000) {
    return {
      kind: 'max_hours',
      detail: `${(r.elapsedMs / 3_600_000).toFixed(2)} h of ${budget.max_hours} h`,
    };
  }
  if (r.cycles >= budget.max_cycles)
    return { kind: 'max_cycles', detail: `${r.cycles} of ${budget.max_cycles} cycles` };
  return undefined;
}

/** Fraction of the tightest of USD / time / cycles already used. */
export function budgetFraction(budget: OmnexxConfig['budget'], r: RunLimits): number {
  return Math.max(
    r.spentUsd / budget.max_usd,
    r.elapsedMs / (budget.max_hours * 3_600_000),
    r.cycles / budget.max_cycles,
  );
}

/** Inside the wrap-up reserve (plan §14.5) no new task starts. */
export const inWrapup = (budget: OmnexxConfig['budget'], r: RunLimits): boolean =>
  budget.wrapup_reserve > 0 && budgetFraction(budget, r) >= 1 - budget.wrapup_reserve;

export const shouldWarn = (budget: OmnexxConfig['budget'], r: RunLimits): boolean =>
  budgetFraction(budget, r) >= budget.warn_at;
