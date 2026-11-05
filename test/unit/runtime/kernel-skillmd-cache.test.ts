import { describe, expect, it } from 'vitest';
import { cachedSearch } from '../../../src/runtime/kernel/discover.js';

describe('bug #15: SkillMD search is cached', () => {
  it('dedupes repeated queries within the TTL and refetches after', async () => {
    let calls = 0;
    let t = 0;
    const search = cachedSearch(
      (q: string) => {
        calls++;
        return Promise.resolve([q]);
      },
      { ttlMs: 1000, now: () => t },
    );
    await search('PDF tools', 5);
    await search('  pdf   tools ', 5);
    await Promise.all([search('pdf tools', 5), search('pdf tools', 5)]);
    expect(calls).toBe(1);
    t = 2000;
    await search('pdf tools', 5);
    expect(calls).toBe(2);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const search = cachedSearch(() => {
      calls++;
      return Promise.reject(new Error('down'));
    });
    await expect(search('x', 1)).rejects.toThrow('down');
    await expect(search('x', 1)).rejects.toThrow('down');
    expect(calls).toBe(2);
  });
});
