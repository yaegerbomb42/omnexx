import { describe, expect, it } from 'vitest';
import { TRIVIAL_BENCH } from '../../../test/fixtures/trivial-bench.js';
import {
  TRIVIAL_MAX_TOKENS,
  TRIVIAL_MAX_TURNS,
  isTrivialGoal,
  trivialCost,
} from '../../../src/core/fast-path.js';

describe('trivial fast path: single-shot edit for one-line changes', () => {
  it('detects trivial goals (short, names one file)', () => {
    expect(isTrivialGoal('bump the version in package.json to 2.0.0')).toBe(true);
    expect(isTrivialGoal('fix the off-by-one in src/math.js')).toBe(true);
    expect(isTrivialGoal('update the year in LICENSE.txt to 2027')).toBe(true);
  });

  it('rejects non-trivial goals (too long, no file, multiple files)', () => {
    expect(isTrivialGoal('refactor the whole auth module')).toBe(false);
    expect(isTrivialGoal('add a new feature to src/auth.js and update tests')).toBe(false);
    expect(isTrivialGoal('x'.repeat(50))).toBe(false);
    expect(isTrivialGoal('')).toBe(false);
    expect(isTrivialGoal('bump package.json and src/index.ts')).toBe(false);
  });

  it('estimates trivial cost within budget', () => {
    for (const { goal } of TRIVIAL_BENCH) {
      const cost = trivialCost(goal);
      expect(cost.turns).toBeLessThanOrEqual(TRIVIAL_MAX_TURNS);
      expect(cost.tokens).toBeLessThanOrEqual(TRIVIAL_MAX_TOKENS);
    }
  });

  it('bench cases all pass token/turn bounds', () => {
    for (const { goal } of TRIVIAL_BENCH) {
      expect(isTrivialGoal(goal)).toBe(true);
    }
  });
});
