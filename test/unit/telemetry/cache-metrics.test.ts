import { describe, expect, it } from 'vitest';
import {
  callHitRate,
  cacheHitRate,
  collectCacheMetrics,
  emptyCacheMetrics,
  foldSample,
  savedTokens,
  savedUsd,
  sampleHit,
  sampleHitRate,
} from '../../../src/telemetry/cache-metrics.js';
import type { OmnexxEvent } from '../../../src/core/events.js';

const SAMPLE = {
  uncached: 100,
  cacheRead: 400,
  cacheWrite: 10,
  output: 50,
  provider: 'anthropic',
  model: 'm',
};

describe('cache metrics', () => {
  it('starts empty', () => {
    const m = emptyCacheMetrics();
    expect(m.calls).toBe(0);
    expect(cacheHitRate(m)).toBe(0);
    expect(callHitRate(m)).toBe(0);
    expect(savedTokens(m)).toBe(0);
    expect(savedUsd(m, 10)).toBe(0);
  });

  it('rates a sample', () => {
    expect(sampleHitRate(SAMPLE)).toBeCloseTo(0.8);
    expect(sampleHit(SAMPLE)).toBe(true);
    expect(sampleHitRate({ uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0);
    expect(sampleHitRate({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeUndefined();
    expect(sampleHit({ uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(false);
  });

  it('folds a sample into totals', () => {
    const m = foldSample(emptyCacheMetrics(), SAMPLE);
    expect(m.uncached).toBe(100);
    expect(m.cacheRead).toBe(400);
    expect(m.cacheWrite).toBe(10);
    expect(m.output).toBe(50);
    expect(m.calls).toBe(1);
    expect(m.hits).toBe(1);
    expect(m.misses).toBe(0);
    const anthropic = m.byProvider.anthropic;
    if (!anthropic) throw new Error('no anthropic totals');
    expect(anthropic.hits).toBe(1);
    expect(anthropic.cacheRead).toBe(400);

    // A miss increments misses.
    const m2 = foldSample(m, { ...SAMPLE, cacheRead: 0, uncached: 500 });
    expect(m2.hits).toBe(1);
    expect(m2.misses).toBe(1);
    expect(cacheHitRate(m2)).toBeCloseTo(400 / 1000);
    expect(callHitRate(m2)).toBe(0.5);
  });

  it('collects from turn events', () => {
    const events: OmnexxEvent[] = [
      {
        ts: 0,
        runId: 'r',
        cycle: 1,
        type: 'turn',
        tokens: { uncached: 100, cacheRead: 400, cacheWrite: 10, output: 50 },
        provider: 'anthropic',
        model: 'm',
      },
      {
        ts: 0,
        runId: 'r',
        cycle: 1,
        type: 'turn',
        tokens: { uncached: 50, cacheRead: 50, cacheWrite: 0, output: 10 },
        provider: 'openai',
        model: 'n',
      },
      { ts: 0, runId: 'r', cycle: 1, type: 'span', name: 'x' },
    ];
    const m = collectCacheMetrics(events);
    expect(m.calls).toBe(2);
    expect(m.uncached).toBe(150);
    expect(m.cacheRead).toBe(450);
    expect(cacheHitRate(m)).toBeCloseTo(450 / 600);
    const anthropic = m.byProvider.anthropic;
    if (!anthropic) throw new Error('no anthropic totals');
    expect(anthropic.hits).toBe(1);
    const openai = m.byProvider.openai;
    if (!openai) throw new Error('no openai totals');
    expect(openai.hits).toBe(1);
  });

  it('reports savings', () => {
    const m = foldSample(emptyCacheMetrics(), { ...SAMPLE, cacheRead: 1_000_000 });
    expect(savedTokens(m)).toBe(1_000_000);
    // 90% of the read price.
    expect(savedUsd(m, 10)).toBeCloseTo((1_000_000 * 10 * 0.9) / 1_000_000);
  });
});
