import { describe, expect, it } from 'vitest';
import {
  computeTurnBudgetPlan,
  parseTokensPerTurn,
  TurnBudgetAllocator,
} from '../../../src/agent/turn-budget.js';
import {
  RedundantReadTracker,
  VerificationCoalescer,
  normalizeVerifyCommand,
  readSliceKey,
} from '../../../src/agent/redundant-read.js';

const BUDGETS = [1_000, 4_000, 16_000, 64_000, 256_000] as const;

describe('parseTokensPerTurn', () => {
  it('parses plain integers and k shorthand cleanly', () => {
    expect(parseTokensPerTurn('4096')).toBe(4096);
    expect(parseTokensPerTurn('4000')).toBe(4000);
    expect(parseTokensPerTurn('1k')).toBe(1_000);
    expect(parseTokensPerTurn('4k')).toBe(4_000);
    expect(parseTokensPerTurn('32k')).toBe(32_000);
    expect(parseTokensPerTurn('256k')).toBe(256_000);
  });

  it('clamps to the 1k–256k window', () => {
    expect(parseTokensPerTurn('999')).toBe(1_000);
    expect(parseTokensPerTurn('300k')).toBe(256_000);
    expect(parseTokensPerTurn('0.5k')).toBe(1_000);
  });

  it('rejects malformed input and unsupported suffixes', () => {
    expect(() => parseTokensPerTurn('lots')).toThrow();
    expect(() => parseTokensPerTurn('')).toThrow();
    expect(() => parseTokensPerTurn('1.5k2')).toThrow();
    expect(() => parseTokensPerTurn('1M')).toThrow();
  });
});

describe('TurnBudgetAllocator', () => {
  it('is deterministic: a fixed budget yields an identical plan every time (byte-stable epoch)', () => {
    const a = new TurnBudgetAllocator();
    const plan1 = a.planFor(16_000);
    const plan2 = a.planFor(16_000);
    // Memoized per budget: same reference, so req.tools/req.system stay byte-identical.
    expect(plan2).toBe(plan1);
    expect(JSON.stringify(plan2)).toBe(JSON.stringify(plan1));
    // A fresh allocator derives the identical plan (pure function).
    const b = new TurnBudgetAllocator();
    expect(JSON.stringify(b.planFor(16_000))).toBe(JSON.stringify(plan1));
  });

  it('scales request token sizing monotonically across budgets', () => {
    const plans = BUDGETS.map((B) => computeTurnBudgetPlan(B));
    for (const key of [
      'core',
      'codemap',
      'goal',
      'facts',
      'lessons',
      'cycleAnchor',
      'initialLsf',
    ] as const) {
      const values = plans.map((p) => p.slotBudgets[key]);
      for (let i = 1; i < values.length; i++)
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] ?? 0);
    }
    const ceil = plans.map((p) => p.prefixCeiling);
    for (let i = 1; i < ceil.length; i++) expect(ceil[i]).toBeGreaterThanOrEqual(ceil[i - 1] ?? 0);
    const maxMounted = plans.map((p) => p.maxMounted);
    expect(maxMounted).toEqual([1, 2, 4, 8, 16]);
    const toolOutput = plans.map((p) => p.toolOutputCeiling);
    for (let i = 1; i < toolOutput.length; i++)
      expect(toolOutput[i]).toBeGreaterThanOrEqual(toolOutput[i - 1] ?? 0);
  });

  it('handles heavy sections on-demand at tight budgets, pinned at larger ones', () => {
    const tight = computeTurnBudgetPlan(2_000);
    expect(tight.heavy).toBe(true);
    expect(tight.sections.codemap).toBe('optional');
    expect(tight.sections.lessons).toBe('optional');
    expect(tight.sections.intent).toBe('optional');
    expect(tight.sections.progress).toBe('optional');
    expect(tight.sections.role).toBe('pinned');
    const roomy = computeTurnBudgetPlan(64_000);
    expect(roomy.heavy).toBe(false);
    expect(roomy.sections.codemap).toBe('pinned');
    expect(roomy.sections.lessons).toBe('pinned');
  });
});

describe('RedundantReadTracker', () => {
  it('short-circuits an unchanged re-read of the same slice', () => {
    const t = new RedundantReadTracker();
    const slice = readSliceKey('src/a.ts', 1, 50);
    expect(t.record('src/a.ts', slice)).toBe(false);
    expect(t.record('src/a.ts', slice)).toBe(true);
    expect(t.redundantReads).toBe(1);
    // A different slice of the same file is a fresh read.
    expect(t.record('src/a.ts', readSliceKey('src/a.ts', 51, 100))).toBe(false);
  });

  it('invalidates after a mutating tool passes (edit/bash)', () => {
    const t = new RedundantReadTracker();
    const slice = readSliceKey('src/a.ts', 1, 50);
    t.record('src/a.ts', slice);
    expect(t.record('src/a.ts', slice)).toBe(true);
    // An edit touches the file: invalidation lets it re-read for real.
    t.invalidate(['src/a.ts']);
    expect(t.record('src/a.ts', slice)).toBe(false);
    // A blanket invalidation (any mutating tool) also resets.
    t.record('src/a.ts', slice);
    t.invalidate();
    expect(t.record('src/a.ts', slice)).toBe(false);
  });

  it('supports explicit saved-token credits and snapshots', () => {
    const t = new RedundantReadTracker();
    t.noteSavedTokens(1_200);
    expect(t.snapshot()).toEqual({ redundantReads: 0, tokensSaved: 1_200 });
  });
});

describe('VerificationCoalescer', () => {
  it('short-circuits back-to-back identical verification with zero mutations', () => {
    const c = new VerificationCoalescer();
    expect(c.decide('npm test', 1, 0)).toBe('run');
    expect(c.decide('npm test', 2, 0)).toBe('skip');
  });

  it('normalizes npx/pnpm prefixes so the same command matches', () => {
    expect(normalizeVerifyCommand('npx vitest')).toBe('vitest');
    expect(normalizeVerifyCommand('  pnpm test ')).toBe('test');
    const c = new VerificationCoalescer();
    expect(c.decide('npx vitest run', 1, 0)).toBe('run');
    expect(c.decide('vitest run', 2, 0)).toBe('skip');
  });

  it('re-runs when a mutating tool passed in between', () => {
    const c = new VerificationCoalescer();
    expect(c.decide('npm test', 1, 0)).toBe('run');
    // Mutation at seq 2; the next identical verify is not adjacent/clean.
    expect(c.decide('npm test', 3, 2)).toBe('run');
  });

  it('invalidates after a mutation and a different command resets the window', () => {
    const c = new VerificationCoalescer();
    c.decide('npm test', 1, 0);
    c.invalidate();
    expect(c.decide('npm test', 2, 0)).toBe('run');
    c.decide('npm test', 3, 0);
    c.decide('npm run lint', 4, 0);
    expect(c.decide('npm test', 5, 0)).toBe('run');
  });
});
