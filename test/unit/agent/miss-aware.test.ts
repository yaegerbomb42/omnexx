import { describe, expect, it } from 'vitest';
import { missAwareSettings, type CompactionSettings } from '../../../src/agent/compaction.js';

const base: CompactionSettings = {
  clearAt: 60_000,
  keepToolResults: 6,
  compactAt: 100_000,
  keepTurns: 4,
};

describe('missAwareSettings: fold sooner when the provider cache keeps missing', () => {
  it('leaves the thresholds alone at or below the baseline miss rate', () => {
    expect(missAwareSettings(base, 0, 0)).toBe(base);
    expect(missAwareSettings(base, 0, 200)).toBe(base);
    expect(missAwareSettings(base, 2, 100)).toBe(base);
  });

  it('does not overreact to one early miss', () => {
    const s = missAwareSettings(base, 1, 2);
    expect(s.compactAt).toBeGreaterThan(80_000);
  });

  it('scales clear and fold down with the observed miss rate (bench rate ~7%)', () => {
    const s = missAwareSettings(base, 17, 245);
    expect(s.compactAt).toBeLessThan(85_000);
    expect(s.compactAt).toBeGreaterThan(65_000);
    expect(s.clearAt / s.compactAt).toBeCloseTo(0.6, 2);
    expect(s.keepTurns).toBe(base.keepTurns);
  });

  it('never goes below half the configured thresholds', () => {
    const s = missAwareSettings(base, 100, 100);
    expect(s.compactAt).toBe(50_000);
    expect(s.clearAt).toBe(30_000);
  });
});
