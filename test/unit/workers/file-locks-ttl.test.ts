import { describe, expect, it } from 'vitest';
import { RegionLockManager, type FileRegion } from '../../../src/workers/file-locks.js';

const region = (path: string, startLine: number, endLine: number): FileRegion => ({
  path,
  startLine,
  endLine,
});

describe('RegionLockManager TTL timer', () => {
  it('wakes a waiter queued behind a TTL lock at expiry instead of timing out (bug-hunt-2 #3)', async () => {
    const locks = new RegionLockManager();

    // A holds src/a.ts:1-10 with a 50ms TTL and never releases (dead-owner backstop).
    await locks.acquire('a', [region('src/a.ts', 1, 10)], { ttlMs: 50 });

    // B overlaps 5-6 with a generous timeout. Once A's TTL fires at ~50ms, B must be
    // granted, not left to idle out its full 2000ms timeout (pre-fix: LockTimeoutError).
    const start = Date.now();
    const b = await locks.acquire('b', [region('src/a.ts', 5, 6)], { timeoutMs: 2000 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(locks.activeLocks().map((l) => l.ownerId)).toEqual(['b']);
    b.release();
    expect(locks.activeLocks()).toEqual([]);
  });
});
