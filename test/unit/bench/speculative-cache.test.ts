import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  benchAstCache,
  benchPrefixPinning,
  benchSpeculativeChecks,
  formatReport,
  runBenchmarks,
} from './speculative-cache.js';

/**
 * The speculative-cache benchmark.
 *
 * It measures the three things the work changed, and writes the before/after numbers to
 * `bench/results/speculative-cache.md` so the deltas are visible in the repo:
 *
 * 1. The AST cache: the codebase map over an unchanged tree, and the files re-read.
 * 2. The prefix pinning: the cacheable share of the prompt and the hit rate over a
 *    long conversation. The target is above 80%.
 * 3. The speculative checks: the time from a write to the check's result.
 */
describe('the speculative-cache benchmark', () => {
  it('rebuilds the codebase map without re-reading a single file', async () => {
    const { comparisons, measurements } = await benchAstCache();
    const rereads = measurements.find((m) => m.name === 'ast.cache.rereads_unchanged');
    expect(rereads?.value).toBe(0);
    // The cache must not change a single byte of the map.
    const identical = measurements.find((m) => m.name === 'ast.cache.map_identical');
    expect(identical?.value).toBe(1);
    const warm = comparisons.find((c) => c.name.startsWith('codebase map build'));
    expect(warm).toBeDefined();
    // Timing varies; the guarantee is in the measurements below (0 re-reads, identical map).
    expect(typeof warm?.after).toBe('number');
  }, 120_000);

  it('keeps more than 80% of the prompt in the cacheable prefix', () => {
    const { comparisons, measurements } = benchPrefixPinning();
    const hit = measurements.find((m) => m.name === 'cache.pinned_token_hit_rate');
    expect(hit).toBeDefined();
    expect(hit?.value ?? 0).toBeGreaterThan(80);
    const stability = measurements.find((m) => m.name === 'cache.pinned_stability');
    expect(stability?.value ?? 0).toBeGreaterThan(80);
    // The pinning must beat the unpinned arrangement.
    const calls = comparisons.find((c) => c.name.startsWith('calls that read'));
    expect(calls?.after ?? 0).toBeGreaterThan(calls?.before ?? 100);
  });

  it('overlaps the check with the model stream', () => {
    const { comparisons } = benchSpeculativeChecks();
    const overlap = comparisons.find((c) => c.name.startsWith('time from write'));
    expect(overlap?.before ?? 0).toBeGreaterThan(overlap?.after ?? 100);
  });

  it('writes the before/after report', async () => {
    const report = await runBenchmarks();
    const text = formatReport(report);
    expect(text).toContain('codebase map build');
    expect(text).toContain('prompt tokens read from the cache');
    const dir = join(process.cwd(), 'bench', 'results');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'speculative-cache.md'),
      `# Speculative cache benchmark\n\n${text}\n`,
    );
  }, 120_000);
});
