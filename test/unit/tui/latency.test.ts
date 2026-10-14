import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  estimateLatency,
  loadLatency,
  MAX_SAMPLES,
  recordLatency,
  saveLatency,
  type LatencyStats,
} from '../../../src/tui/latency.js';
import { tempDir } from '../../support/tmp.js';

describe('latency estimates', () => {
  it('has no estimate without history', () => {
    expect(estimateLatency({}, 'a:m', 1000)).toBeUndefined();
  });

  it('uses the median time, scaled by prompt size within limits', () => {
    const stats = [1000, 2000, 9000].reduce<LatencyStats>(
      (s, ms) => recordLatency(s, 'a:m', { ms, tokens: 1000 }),
      {},
    );
    expect(estimateLatency(stats, 'a:m', 1000)).toBe(2000);
    expect(estimateLatency(stats, 'a:m', 2000)).toBe(4000);
    expect(estimateLatency(stats, 'a:m', 100_000)).toBe(6000);
    expect(estimateLatency(stats, 'a:m', 1)).toBe(667);
  });

  it('keeps the last samples per model, ignores bad ones, and never mutates', () => {
    const empty: LatencyStats = {};
    let stats = recordLatency(empty, 'a:m', { ms: 0, tokens: 1 });
    expect(stats).toBe(empty);
    for (let i = 1; i <= MAX_SAMPLES + 5; i++)
      stats = recordLatency(stats, 'a:m', { ms: i, tokens: 1 });
    expect(stats['a:m']).toHaveLength(MAX_SAMPLES);
    expect(stats['a:m']?.[0]?.ms).toBe(6);
    expect(empty).toEqual({});
  });

  it('saves and loads, treating a broken file as no history', async () => {
    const dir = await tempDir();
    const file = join(dir, 'latency.json');
    expect(await loadLatency(file)).toEqual({});
    await saveLatency(file, recordLatency({}, 'a:m', { ms: 50, tokens: 10 }));
    expect(await loadLatency(file)).toEqual({ 'a:m': [{ ms: 50, tokens: 10 }] });
  });
});
