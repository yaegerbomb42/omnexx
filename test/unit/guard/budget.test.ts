import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import {
  budgetFraction,
  dailyPauseThreshold,
  inWrapup,
  preflight,
  runLimitHit,
  shouldWarn,
  spentInWindow,
  windowRollsAt,
} from '../../../src/guard/budget.js';
import { BUILTIN_PRICING, costUsd } from '../../../src/providers/pricing.js';

const price =
  BUILTIN_PRICING.sonnet ??
  (() => {
    throw new Error('x');
  })();

/** Tiny seeded PRNG so the property test is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('preflight', () => {
  const budget = defaultConfig({
    budget: { max_usd: 1, max_turns_per_cycle: 5, max_tokens_per_cycle: 100_000 },
  }).budget;
  const base = {
    spentUsd: 0,
    cycle: { turns: 0, tokens: 0 },
    estimatedInputTokens: 10_000,
    maxOutputTokens: 1_000,
    price,
  };

  it('allows, then stops on turns, tokens and dollars', () => {
    expect(preflight(budget, base)).toMatchObject({ ok: true });
    expect(preflight(budget, { ...base, cycle: { turns: 5, tokens: 0 } })).toMatchObject({
      ok: false,
      stop: 'max_turns_per_cycle',
    });
    expect(preflight(budget, { ...base, cycle: { turns: 1, tokens: 95_000 } })).toMatchObject({
      ok: false,
      stop: 'max_tokens_per_cycle',
    });
    expect(preflight(budget, { ...base, spentUsd: 0.99 })).toMatchObject({
      ok: false,
      stop: 'max_usd',
    });
  });

  it('property: across random usage, spend never exceeds the cap by more than one turn', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const cap = 0.05 + rand() * 2;
      const b = defaultConfig({
        budget: { max_usd: cap, max_turns_per_cycle: 10_000, max_tokens_per_cycle: 1e12 },
      }).budget;
      let spent = 0;
      let maxTurnCost = 0;
      for (let turn = 0; turn < 5_000; turn++) {
        const estimate = Math.floor(1_000 + rand() * 50_000);
        const maxOut = Math.floor(500 + rand() * 8_000);
        const pf = preflight(b, {
          ...base,
          spentUsd: spent,
          estimatedInputTokens: estimate,
          maxOutputTokens: maxOut,
        });
        if (!pf.ok) break;
        // Actual usage: estimate may be off by up to +20%, split randomly across cache classes.
        const actualIn = Math.floor(estimate * (0.5 + rand() * 0.7));
        const read = Math.floor(actualIn * rand());
        const write = Math.floor((actualIn - read) * rand());
        const cost = costUsd(
          {
            uncached: actualIn - read - write,
            cacheWrite5m: write,
            cacheWrite1h: 0,
            cacheRead: read,
            output: Math.floor(maxOut * rand()),
          },
          price,
        );
        maxTurnCost = Math.max(maxTurnCost, cost);
        spent += cost;
      }
      expect(spent, `seed ${seed}`).toBeLessThanOrEqual(cap + maxTurnCost);
    }
  });
});

describe('run limits, warn and wrap-up', () => {
  const budget = defaultConfig({ budget: { max_usd: 50, max_hours: 24, max_cycles: 300 } }).budget;
  it('hits each cap', () => {
    expect(runLimitHit(budget, { spentUsd: 50, elapsedMs: 0, cycles: 0 })?.kind).toBe('max_usd');
    expect(runLimitHit(budget, { spentUsd: 0, elapsedMs: 24 * 3_600_000, cycles: 0 })?.kind).toBe(
      'max_hours',
    );
    expect(runLimitHit(budget, { spentUsd: 0, elapsedMs: 0, cycles: 300 })?.kind).toBe(
      'max_cycles',
    );
    expect(runLimitHit(budget, { spentUsd: 1, elapsedMs: 1, cycles: 1 })).toBeUndefined();
  });
  it('warns at 80% and enters wrap-up in the last 8% of the tightest dimension', () => {
    const at = (f: number) => ({ spentUsd: 0, elapsedMs: f * 24 * 3_600_000, cycles: 0 });
    expect(budgetFraction(budget, at(0.5))).toBeCloseTo(0.5);
    expect(shouldWarn(budget, at(0.79))).toBe(false);
    expect(shouldWarn(budget, at(0.8))).toBe(true);
    expect(inWrapup(budget, at(0.91))).toBe(false);
    expect(inWrapup(budget, at(0.93))).toBe(true);
    expect(inWrapup(defaultConfig({ budget: { wrapup_reserve: 0 } }).budget, at(0.99))).toBe(false);
  });
});

describe('rolling daily cap', () => {
  const H = 3_600_000;
  const ledger = [
    { at: 0, usd: 4 },
    { at: 2 * H, usd: 3 },
    { at: 10 * H, usd: 2 },
  ];
  it('sums only the last 24 h', () => {
    expect(spentInWindow(ledger, 12 * H)).toBe(9);
    expect(spentInWindow(ledger, 25 * H)).toBe(5);
    expect(spentInWindow(ledger, 35 * H)).toBe(0);
  });
  it('finds when enough spend has rolled out of the window', () => {
    expect(windowRollsAt(ledger, 12 * H, 6)).toBe(24 * H); // the $4 entry expires
    expect(windowRollsAt(ledger, 12 * H, 2)).toBe(26 * H); // both early entries must expire
    expect(windowRollsAt(ledger, 12 * H, 10)).toBe(12 * H); // already under
  });
  it('pre-flight refuses a call that could cross the daily cap', () => {
    const budget = defaultConfig({ budget: { max_usd_per_day: 1 } }).budget;
    const r = preflight(budget, {
      spentUsd: 0,
      spentTodayUsd: 0.999,
      cycle: { turns: 0, tokens: 0 },
      estimatedInputTokens: 10_000,
      maxOutputTokens: 1_000,
      price,
    });
    expect(r).toMatchObject({ ok: false, stop: 'max_usd_per_day' });
    expect(dailyPauseThreshold(budget)).toBe(0.9);
  });
});
