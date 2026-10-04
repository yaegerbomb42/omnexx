import type { OmnexxConfig, PriceConfig } from '../config/schema.js';
import { worstCaseUsd } from '../providers/pricing.js';

export type BudgetStop = 'max_usd' | 'max_turns_per_cycle' | 'max_tokens_per_cycle';

export interface CycleUsage {
  turns: number;
  /** Input + output tokens of every call this cycle, before cache discounts. */
  tokens: number;
}

export interface PreflightInput {
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
  return { ok: true, worstCaseUsd: worst };
}

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
