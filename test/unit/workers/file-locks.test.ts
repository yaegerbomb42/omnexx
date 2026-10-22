import { describe, expect, it } from 'vitest';
import {
  LockTimeoutError,
  RegionLockManager,
  type FileRegion,
} from '../../../src/workers/file-locks.js';

const region = (path: string, startLine: number, endLine: number): FileRegion => ({
  path,
  startLine,
  endLine,
});

/** Let queued microtasks/timers run so "still waiting" assertions are meaningful. */
const tick = async (ms = 15): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('RegionLockManager', () => {
  it('grants non-overlapping regions of the same file to different owners', async () => {
    const locks = new RegionLockManager();
    const a = await locks.acquire('a', [region('src/x.ts', 1, 10)]);
    const b = await locks.acquire('b', [region('src/x.ts', 11, 20)]);
    expect(locks.activeLocks().map((l) => l.ownerId)).toEqual(['a', 'b']);
    a.release();
    b.release();
    expect(locks.activeLocks()).toEqual([]);
  });

  it('queues an overlapping acquire until the holder releases', async () => {
    const locks = new RegionLockManager();
    const first = await locks.acquire('a', [region('src/x.ts', 1, 50)]);

    let granted = false;
    const waiting = locks.acquire('b', [region('src/x.ts', 40, 60)]).then((h) => {
      granted = true;
      return h;
    });
    await tick();
    expect(granted).toBe(false);

    first.release();
    const second = await waiting;
    expect(granted).toBe(true);
    expect(locks.activeLocks().map((l) => l.ownerId)).toEqual(['b']);
    second.release();
  });

  it('treats touching-but-not-overlapping ranges as conflict-free', async () => {
    const locks = new RegionLockManager();
    const a = await locks.acquire('a', [region('src/x.ts', 1, 10)]);
    // Line 11 starts exactly where a's range ends (ranges are inclusive): no conflict.
    const b = await locks.acquire('b', [region('src/x.ts', 11, 11)], { timeoutMs: 50 });
    a.release();
    b.release();
  });

  it('rejects a conflicting acquire with LockTimeoutError after timeoutMs', async () => {
    const locks = new RegionLockManager();
    const first = await locks.acquire('a', [region('src/x.ts', 1, 50)]);
    await expect(
      locks.acquire('b', [region('src/x.ts', 25, 30)], { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    first.release();
    // The timed-out waiter left the queue: the region is free for the next arrival.
    const next = await locks.acquire('b', [region('src/x.ts', 25, 30)], { timeoutMs: 50 });
    next.release();
  });

  it('never blocks on a different file', async () => {
    const locks = new RegionLockManager();
    const a = await locks.acquire('a', [region('src/x.ts', 1, 500)]);
    const b = await locks.acquire('b', [region('src/y.ts', 1, 500)], { timeoutMs: 50 });
    a.release();
    b.release();
  });

  it('withLock releases on throw and on success', async () => {
    const locks = new RegionLockManager();
    await expect(
      locks.withLock('a', [region('src/x.ts', 1, 10)], () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(locks.activeLocks()).toEqual([]);

    const value = await locks.withLock('a', [region('src/x.ts', 1, 10)], () => {
      expect(locks.activeLocks()).toHaveLength(1);
      return 42;
    });
    expect(value).toBe(42);
    expect(locks.activeLocks()).toEqual([]);
  });

  it('wakes waiters in FIFO order per file', async () => {
    const locks = new RegionLockManager();
    const holder = await locks.acquire('holder', [region('src/x.ts', 1, 100)]);
    const order: string[] = [];
    const w1 = locks.acquire('w1', [region('src/x.ts', 1, 10)]).then((h) => {
      order.push('w1');
      return h;
    });
    const w2 = locks.acquire('w2', [region('src/x.ts', 20, 30)]).then((h) => {
      order.push('w2');
      return h;
    });
    await tick();
    holder.release();
    const h1 = await w1;
    // w2's region does not overlap w1's, so FIFO does not force it to wait for w1's release;
    // but w1 queued first and must be granted first.
    expect(order[0]).toBe('w1');
    h1.release();
    const h2 = await w2;
    h2.release();
  });

  it('expires locks lazily once their TTL passes', async () => {
    let t = 1_000;
    const locks = new RegionLockManager({ now: () => t });
    await locks.acquire('a', [region('src/x.ts', 1, 10)], { ttlMs: 100 });
    expect(locks.activeLocks()).toHaveLength(1);
    t = 1_101;
    // The dead owner's lock no longer blocks; acquiring prunes it first.
    const b = await locks.acquire('b', [region('src/x.ts', 1, 10)], { timeoutMs: 50 });
    expect(locks.activeLocks().map((l) => l.ownerId)).toEqual(['b']);
    b.release();
  });
});
