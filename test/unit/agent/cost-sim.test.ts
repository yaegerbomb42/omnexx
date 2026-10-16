import { describe, expect, it } from 'vitest';
import { MIN_CLEAR_TOKENS, SETTLE_FRACTION } from '../../../src/agent/compaction.js';
import {
  simulate,
  syntheticTrajectory,
  type SimPolicy,
  type SimResult,
} from '../../../src/agent/cost-sim.js';
import { FOLD_FRACTION } from '../../../src/core/agent-levels.js';

/** Sonnet-class worker, Haiku-class folder (USD per MTok). */
const PRICE = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
const CHEAP = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const SYSTEM = 12_000;
const SEEDS = 20;
const TURNS = 150;

/** Before this change: fold (compact) at the budget, prune only once past the clear line. */
const today = (budget: number): SimPolicy => ({
  name: 'today',
  budget,
  foldFraction: 1,
  clearFraction: 0.6,
  keepTurns: 4,
  keepResults: 6,
  pruneMinTokens: Infinity,
  stateBase: 1_500,
  statePerTurn: 40,
  stateMax: 4_000,
});

/** Now: prune continuously (batched by MIN_CLEAR_TOKENS), fold near the budget, settle after. */
const workingState = (budget: number): SimPolicy => ({
  ...today(budget),
  name: 'working-state',
  foldFraction: FOLD_FRACTION,
  pruneMinTokens: MIN_CLEAR_TOKENS,
  settleFraction: SETTLE_FRACTION,
});

function average(policy: SimPolicy): SimResult {
  const sum: SimResult = {
    usd: 0,
    inputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    folds: 0,
    prunes: 0,
    maxContext: 0,
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = simulate(syntheticTrajectory(seed, TURNS), policy, SYSTEM, PRICE, CHEAP);
    sum.usd += r.usd / SEEDS;
    sum.inputTokens += r.inputTokens / SEEDS;
    sum.cacheRead += r.cacheRead / SEEDS;
    sum.cacheWrite += r.cacheWrite / SEEDS;
    sum.folds += r.folds / SEEDS;
    sum.prunes += r.prunes / SEEDS;
    sum.maxContext = Math.max(sum.maxContext, r.maxContext);
  }
  return sum;
}

describe('cost simulator', () => {
  it.each([40_000, 96_000, 200_000, 1_000_000])(
    'the working-state policy costs no more than before and stays in budget at %i',
    (budget) => {
      const before = average(today(budget));
      const now = average(workingState(budget));
      expect(now.usd).toBeLessThanOrEqual(before.usd);
      expect(now.inputTokens).toBeLessThanOrEqual(before.inputTokens);
      expect(now.maxContext).toBeLessThanOrEqual(budget);
    },
  );

  it('settling after a fold is what keeps small budgets from folding every few turns', () => {
    const unsettled = average({ ...workingState(40_000), settleFraction: 0 });
    const settled = average(workingState(40_000));
    expect(settled.folds).toBeLessThan(unsettled.folds * 0.6);
    expect(settled.usd).toBeLessThan(unsettled.usd);
  });

  it('pruning on every turn (no batching) costs more than batching by MIN_CLEAR_TOKENS', () => {
    for (const budget of [200_000, 1_000_000]) {
      const eager = average({ ...workingState(budget), pruneMinTokens: 0 });
      expect(average(workingState(budget)).usd).toBeLessThan(eager.usd);
    }
  });

  it('a stable prefix is read from the cache: most input is cache reads', () => {
    const r = average(workingState(200_000));
    expect(r.cacheRead / r.inputTokens).toBeGreaterThan(0.85);
  });
});
