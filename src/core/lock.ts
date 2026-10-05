import { open, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { LockError } from '../errors.js';

export const lockSchema = z.object({
  pid: z.number(),
  host: z.string(),
  bootId: z.string(),
  startedAt: z.number(),
});
export type LockInfo = z.infer<typeof lockSchema>;

export interface LockEnv {
  pid: number;
  host: string;
  bootId: string;
  now: number;
  isAlive: (pid: number) => boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const defaultLockEnv = (bootId: string, now: number): LockEnv => ({
  pid: process.pid,
  host: hostname(),
  bootId,
  now,
  isAlive: pidAlive,
});

export async function readLock(dir: string): Promise<LockInfo | undefined> {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(await readFile(join(dir, 'lock'), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Stale = same host and (different boot, or that pid is gone). Another host's lock is never stale. */
export function isStale(
  lock: LockInfo,
  env: Pick<LockEnv, 'host' | 'bootId' | 'isAlive'>,
): boolean {
  if (lock.host !== env.host) return false;
  return lock.bootId !== env.bootId || !env.isAlive(lock.pid);
}

export type AcquireResult =
  { acquired: true; tookOverFrom?: LockInfo } | { acquired: false; holder: LockInfo };

/**
 * Exactly one supervisor per run. Creation is O_EXCL; a stale lock is renamed away first (only
 * one contender's rename succeeds), so two resumes racing for a dead run can't both win.
 */
export async function acquireLock(dir: string, env: LockEnv): Promise<AcquireResult> {
  const path = join(dir, 'lock');
  const mine: LockInfo = { pid: env.pid, host: env.host, bootId: env.bootId, startedAt: env.now };
  let tookOverFrom: LockInfo | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(mine));
        await fh.sync();
      } finally {
        await fh.close();
      }
      return tookOverFrom ? { acquired: true, tookOverFrom } : { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = await readLock(dir);
    if (holder && !isStale(holder, env)) return { acquired: false, holder };
    // Serialize takeovers: re-check staleness while holding a short-lived mutex, so a contender
    // that read the old lock can never rename away a fresh lock another contender just wrote.
    const mutex = `${path}.takeover`;
    let fh;
    try {
      fh = await open(mutex, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age =
        env.now -
        (await stat(mutex).then(
          (st) => st.mtimeMs,
          () => env.now,
        ));
      if (age > 30_000) await rm(mutex, { force: true });
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    try {
      const again = await readLock(dir);
      if (again && !isStale(again, env)) return { acquired: false, holder: again };
      await rm(path, { force: true });
      if (again) tookOverFrom = again;
    } finally {
      await fh.close();
      await rm(mutex, { force: true });
    }
  }
  const holder = await readLock(dir);
  if (holder) return { acquired: false, holder };
  throw new LockError(
    `could not take the lock in ${dir}`,
    'retry; if it persists, remove the lock file by hand',
  );
}

/** Release only our own lock. */
export async function releaseLock(dir: string, pid: number): Promise<void> {
  const held = await readLock(dir);
  if (held?.pid === pid) await rm(join(dir, 'lock'), { force: true });
}
