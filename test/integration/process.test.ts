import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { portOpen } from '../../src/browser/dev-server.js';
import { supervisorAlive } from '../../src/cli/commands/control.js';
import { readEvents } from '../../src/core/events.js';
import { readLock } from '../../src/core/lock.js';
import { resolvePaths } from '../../src/core/paths.js';
import { readChildren } from '../../src/core/process-registry.js';
import { listRunIds, RunStore } from '../../src/core/run-store.js';
import { git } from '../../src/git/git.js';
import { parseTrailers } from '../../src/git/trailers.js';
import { entry, processRepo, reapOrphanedChildren, waitFor } from '../support/proc.js';

async function commitsByCycle(worktree: string, from: string): Promise<string[]> {
  const log = (await git(worktree, ['log', '--format=%B%x00', `${from}..HEAD`])).stdout;
  return log
    .split('\0')
    .map((m) => parseTrailers(m))
    .filter((t) => t !== undefined)
    .map((t) => `${t.task}@${t.cycle}`);
}

describe('real processes: detach, heartbeat, pause/resume', () => {
  it('run flags reach the detached supervisor: --budget stops the run', async () => {
    const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: '4' });
    const r = await entry(['run', '--detach', '--budget', '0.0001', 'Create the four files'], {
      cwd: repo,
      env,
    });
    expect(r.code).toBe(0);
    const store = new RunStore(resolvePaths(env), r.stdout.trim());
    const state = await waitFor(
      async () => {
        const s = await store.readState().catch(() => undefined);
        return s && !['running', 'planning', 'created'].includes(s.status) ? s : undefined;
      },
      60_000,
      'run to end',
    );
    expect(state.status).toBe('expired');
    expect(state.acceptedCommits).toBe(0);
    // The supervisor writes REPORT.md after the status; let it exit before temp dirs are removed.
    await waitFor(
      async () => (!(await supervisorAlive(store)) ? true : undefined),
      30_000,
      'supervisor exit',
    );
  });

  it('run --detach returns at once; the run keeps going with a fresh heartbeat; pause takes effect within a turn; resume continues to the end', async () => {
    // Six tasks so the run can't finish before the pause lands, even on a fast runner.
    const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: '6', OMNEXX_TEST_TURN_MS: '150' });
    const started = Date.now();
    const r = await entry(['run', '--detach', 'Create the six files'], { cwd: repo, env });
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
    const runId = r.stdout.trim();
    const store = new RunStore(resolvePaths(env), runId);

    // The CLI process has exited; the detached supervisor is still alive and beating.
    const hb = await waitFor(
      async () => {
        const h = await store.readHeartbeat();
        return h && h.cycle >= 1 ? h : undefined;
      },
      30_000,
      'first cycle',
    );
    expect(Date.now() - hb.ts).toBeLessThan(30_000);

    // Pause first, then inspect: every extra process spawned here gives the run time to finish.
    expect((await entry(['pause', runId], { cwd: repo, env })).code).toBe(0);
    const paused = await waitFor(
      async () => {
        const h = await store.readHeartbeat();
        if (h?.phase === 'done') throw new Error('the run finished before the pause landed');
        return h?.phase === 'paused' ? true : undefined;
      },
      // Generous: a loaded CI runner can take several seconds to reach the next turn boundary.
      30_000,
      'paused heartbeat',
    );
    expect(paused).toBe(true);
    const status = JSON.parse(
      (await entry(['status', runId, '--json'], { cwd: repo, env })).stdout,
    ) as { supervisorAlive: boolean; heartbeat: { ageMs: number } };
    expect(status.supervisorAlive).toBe(true);
    expect(status.heartbeat.ageMs).toBeLessThan(30_000);
    const eventsAtPause = (await readEvents(store.eventsPath)).filter(
      (e) => e.type === 'turn',
    ).length;
    await new Promise((res) => setTimeout(res, 800));
    expect((await readEvents(store.eventsPath)).filter((e) => e.type === 'turn').length).toBe(
      eventsAtPause,
    );

    expect((await entry(['resume', runId], { cwd: repo, env })).code).toBe(0);
    const final = await waitFor(
      async () => {
        const s = await store.readState();
        return s.phase === 'done' ? s : undefined;
      },
      60_000,
      'run to finish',
    );
    expect(final.status).toBe('finished');
    expect(final.acceptedCommits).toBe(6);
    // The supervisor writes the report and releases the lock after the final phase.
    await waitFor(
      async () => ((await readLock(store.dir)) ? undefined : true),
      15_000,
      'lock release',
    );
  });
});

describe('real processes: simulated reboot', () => {
  it('SIGKILL mid-ACT, new boot id, `resume --all` resumes from the right phase within 60 s with no repeated commits', async () => {
    const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: '3' });
    const killed = await entry(['run', 'Create the files'], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_KILL: 'act:2' },
    });
    expect(killed.code).not.toBe(0);
    const [runId] = await listRunIds(resolvePaths(env));
    const store = new RunStore(resolvePaths(env), runId ?? '');
    const before = await store.readState();
    expect(before).toMatchObject({ phase: 'act', cycle: 2, status: 'running' });
    expect(await readLock(store.dir)).toBeDefined(); // the dead supervisor's lock is still there

    const t0 = Date.now();
    const resumed = await entry(['resume', '--all'], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_BOOT_ID: 'boot-after-reboot' },
    });
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain(`resuming ${runId ?? ''}`);
    const after = await store.readState();
    expect(after.status).toBe('finished');
    expect(Date.now() - t0).toBeLessThan(60_000);
    const resumeEvent = (await readEvents(store.eventsPath)).find((e) => e.type === 'run.resume');
    expect(resumeEvent).toMatchObject({ fromPhase: 'act', tookOverFrom: { bootId: 'boot-test' } });
    const commits = await commitsByCycle(after.worktree, after.startRef);
    expect(commits).toHaveLength(3);
    expect(new Set(commits.map((c) => c.split('@')[0])).size).toBe(3);

    // Nothing left to resume: a second boot is a no-op.
    expect((await entry(['resume', '--all'], { cwd: repo, env })).stdout).toContain(
      'nothing to resume',
    );
  });
});

describe('real processes: no orphans after a run ends', () => {
  it('a run that starts a server leaves no child processes and no bound ports behind', async () => {
    const { repo, env } = await processRepo({
      OMNEXX_TEST_TASKS: '2',
      OMNEXX_TEST_SCENARIO: 'server',
    });
    const paths = resolvePaths(env);
    // reapChildren: false — this test asserts on what the run itself left behind; the
    // harness must not clean up before the assertions run.
    const r = await entry(['run', 'Create the files and start the server'], {
      cwd: repo,
      env,
      reapChildren: false,
    });
    expect(r.code).toBe(0);
    const [runId] = await listRunIds(paths);
    expect(runId).toBeDefined();
    const store = new RunStore(paths, runId ?? '');
    try {
      const state = await waitFor(
        async () => {
          const s = await store.readState().catch(() => undefined);
          return s?.phase === 'done' ? s : undefined;
        },
        90_000,
        'run to finish',
      );
      expect(state.status).toBe('finished');
      expect(state.acceptedCommits).toBe(2);
      const pid = Number(await readFile(join(state.worktree, 'server-a.pid'), 'utf8'));
      const port = Number(await readFile(join(state.worktree, 'server-a.port'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(port).toBeGreaterThan(0);
      // The supervisor writes the report and releases the lock after the final phase.
      await waitFor(
        async () => (!(await supervisorAlive(store)) ? true : undefined),
        30_000,
        'supervisor exit',
      );
      // The server was backgrounded inside the persistent shell, so it outlived the turn
      // that started it; run end must have killed the shell's whole process group.
      await waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return undefined;
          } catch {
            return true;
          }
        },
        10_000,
        `server pid ${pid} to die`,
      );
      expect(await portOpen(port)).toBe(false);
      // And the registry is empty: nothing is left for a reaper to find.
      expect(readChildren(paths, runId ?? '')).toEqual([]);
    } finally {
      // Leave nothing for the global teardown to trip over, even on failure.
      await reapOrphanedChildren(env);
    }
  }, 180_000);

  it('a SIGKILLed supervisor leaves orphans that the next CLI invocation reaps', async () => {
    const { repo, env } = await processRepo({
      OMNEXX_TEST_TASKS: '3',
      OMNEXX_TEST_SCENARIO: 'server',
    });
    const paths = resolvePaths(env);
    const killed = await entry(['run', 'Create the files and start the server'], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_KILL: 'act:2' },
      reapChildren: false,
    });
    expect(killed.code).not.toBe(0);
    const [runId] = await listRunIds(paths);
    expect(runId).toBeDefined();
    const store = new RunStore(paths, runId ?? '');
    const state = await store.readState();
    expect(state).toMatchObject({ phase: 'act', cycle: 2, status: 'running' });
    const pid = Number(await readFile(join(state.worktree, 'server-a.pid'), 'utf8'));
    const port = Number(await readFile(join(state.worktree, 'server-a.port'), 'utf8'));
    try {
      // The supervisor died mid-run: the backgrounded server is an orphan (still alive,
      // still holding its port) until something reaps it.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await portOpen(port)).toBe(true);
      // Any CLI invocation reaps orphans of runs with no live supervisor before dispatch.
      expect((await entry(['ps', '--json'], { cwd: repo, env })).code).toBe(0);
      await waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return undefined;
          } catch {
            return true;
          }
        },
        10_000,
        `server pid ${pid} to die`,
      );
      expect(await portOpen(port)).toBe(false);
      expect(readChildren(paths, runId ?? '')).toEqual([]);
    } finally {
      await reapOrphanedChildren(env);
    }
  }, 180_000);
});
