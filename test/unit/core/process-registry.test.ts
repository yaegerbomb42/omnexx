import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidAlive } from '../../../src/core/lock.js';
import { resolvePaths } from '../../../src/core/paths.js';
import {
  bindRun,
  killRunChildren,
  readChildren,
  reapStaleSupervisors,
  registerChild,
  unbindRun,
  unregisterChild,
} from '../../../src/core/process-registry.js';
import { RunStore } from '../../../src/core/run-store.js';

const sleepers: number[] = [];

afterEach(() => {
  for (const pid of sleepers) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  sleepers.length = 0;
  unbindRun();
});

/** A detached `sleep` in its own process group, like a dev server. */
function sleeper(seconds = 60): number {
  const child = spawn('sleep', [String(seconds)], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid ?? 0;
  sleepers.push(pid);
  return pid;
}

describe('process registry', () => {
  it('registers and unregisters children on disk', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-registry-'));
    try {
      const paths = resolvePaths({ OMNEXX_HOME: home });
      bindRun(paths, 'r_test');
      const pid = sleeper();
      registerChild({ pid, pgid: pid, kind: 'server', command: 'sleep 60' });
      expect(readChildren(paths, 'r_test')).toHaveLength(1);
      expect(readChildren(paths, 'r_test')[0]).toMatchObject({ kind: 'server', pid });
      unregisterChild(pid);
      expect(readChildren(paths, 'r_test')).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('killRunChildren SIGTERMs the group and SIGKILLs survivors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-registry-'));
    try {
      const paths = resolvePaths({ OMNEXX_HOME: home });
      bindRun(paths, 'r_test');
      const pid = sleeper();
      registerChild({ pid, pgid: pid, kind: 'server', command: 'sleep 60' });
      expect(pidAlive(pid)).toBe(true);
      const result = await killRunChildren(paths, 'r_test', { graceMs: 1_000 });
      expect(result).toEqual({ killed: 1, survivors: 0 });
      expect(pidAlive(pid)).toBe(false);
      expect(readChildren(paths, 'r_test')).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('killRunChildren tolerates an already-dead pid', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-registry-'));
    try {
      const paths = resolvePaths({ OMNEXX_HOME: home });
      bindRun(paths, 'r_test');
      registerChild({ pid: 999_999, pgid: 999_999, kind: 'task', command: 'gone' });
      const result = await killRunChildren(paths, 'r_test', { graceMs: 100 });
      expect(result).toEqual({ killed: 1, survivors: 0 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reapStaleSupervisors kills the orphans of a run with no live supervisor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-registry-'));
    try {
      const paths = resolvePaths({ OMNEXX_HOME: home });
      bindRun(paths, 'r_test');
      const pid = sleeper();
      registerChild({ pid, pgid: pid, kind: 'server', command: 'sleep 60' });
      unbindRun();
      const reaped = await reapStaleSupervisors(paths, { graceMs: 1_000 });
      expect(reaped.reapedChildren).toContain('r_test');
      expect(pidAlive(pid)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reapStaleSupervisors never touches a supervisor with a fresh heartbeat', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-registry-'));
    try {
      const paths = resolvePaths({ OMNEXX_HOME: home });
      const store = new RunStore(paths, 'r_test');
      await store.init();
      const pid = sleeper();
      await writeFile(
        join(store.dir, 'lock'),
        JSON.stringify({ pid, host: 'x', bootId: 'b', startedAt: Date.now() }),
      );
      await store.writeHeartbeat({
        ts: Date.now(),
        pid,
        phase: 'act',
        status: 'running',
        cycle: 1,
        spentUsd: 0,
        lastGreen: 'abc',
      });
      const reaped = await reapStaleSupervisors(paths, { graceMs: 1_000 });
      expect(reaped.reapedSupervisors).toEqual([]);
      expect(pidAlive(pid)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
