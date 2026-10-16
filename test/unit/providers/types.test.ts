import { describe, expect, it } from 'vitest';
import { budgetTokens } from '../../../src/providers/types.js';

describe('budgetTokens', () => {
  it('weighs cache reads at a tenth, like their price; everything else in full', () => {
    expect(
      budgetTokens({
        uncached: 1_000,
        cacheWrite5m: 200,
        cacheWrite1h: 0,
        cacheRead: 50_000,
        output: 300,
      }),
    ).toBe(1_000 + 200 + 300 + 5_000);
  });
});
