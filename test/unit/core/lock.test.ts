import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireLock,
  isStale,
  pidAlive,
  readLock,
  releaseLock,
  type LockEnv,
} from '../../../src/core/lock.js';
import { readBootId } from '../../../src/daemon/boot-id.js';
import { tempDir } from '../../support/tmp.js';

const env = (over: Partial<LockEnv> = {}): LockEnv => ({
  pid: 100,
  host: 'h',
  bootId: 'b1',
  now: 1,
  isAlive: () => true,
  ...over,
});

describe('lock', () => {
  it('one holder at a time; live holders are respected; release only our own', async () => {
    const dir = await tempDir();
    expect(await acquireLock(dir, env())).toEqual({ acquired: true });
    expect(await acquireLock(dir, env({ pid: 200 }))).toMatchObject({
      acquired: false,
      holder: { pid: 100 },
    });
    await releaseLock(dir, 200);
    expect((await readLock(dir))?.pid).toBe(100);
    await releaseLock(dir, 100);
    expect(await readLock(dir)).toBeUndefined();
  });

  it('takes over when the pid is dead or the boot id changed (reboot); never across hosts', async () => {
    const dir = await tempDir();
    await acquireLock(dir, env());
    expect(await acquireLock(dir, env({ pid: 300, isAlive: (p) => p !== 100 }))).toMatchObject({
      acquired: true,
      tookOverFrom: { pid: 100 },
    });
    expect(await acquireLock(dir, env({ pid: 400, bootId: 'b2' }))).toMatchObject({
      acquired: true,
      tookOverFrom: { pid: 300 },
    });
    expect(
      isStale({ pid: 1, host: 'other', bootId: 'x', startedAt: 0 }, env({ isAlive: () => false })),
    ).toBe(false);
  });

  it('racing takeovers of one stale lock produce exactly one winner', async () => {
    const dir = await tempDir();
    await acquireLock(dir, env());
    const dead = (p: number) => p !== 100;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => acquireLock(dir, env({ pid: 1000 + i, isAlive: dead }))),
    );
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });

  it('a corrupt lock is treated as stale; helpers', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'lock'), 'garbage');
    expect((await acquireLock(dir, env())).acquired).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
    expect((await readBootId()).length).toBeGreaterThan(0);
  });
});
