import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { readLock } from '../../src/core/lock.js';
import { resolvePaths } from '../../src/core/paths.js';
import { listRunIds, RunStore } from '../../src/core/run-store.js';
import { git } from '../../src/git/git.js';
import { parseTrailers } from '../../src/git/trailers.js';
import { entry, processRepo, waitFor } from '../support/proc.js';

async function commitsByCycle(worktree: string, from: string): Promise<string[]> {
  const log = (await git(worktree, ['log', '--format=%B%x00', `${from}..HEAD`])).stdout;
  return log
    .split('\0')
    .map((m) => parseTrailers(m))
    .filter((t) => t !== undefined)
    .map((t) => `${t.task}@${t.cycle}`);
}

describe('real processes: detach, heartbeat, pause/resume', () => {
  it('run --detach returns at once; the run keeps going with a fresh heartbeat; pause takes effect within a turn; resume continues to the end', async () => {
    const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: '4', OMNEXX_TEST_TURN_MS: '150' });
    const started = Date.now();
    const r = await entry(['run', '--detach', 'Create the four files'], { cwd: repo, env });
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
    const status = JSON.parse(
      (await entry(['status', runId, '--json'], { cwd: repo, env })).stdout,
    ) as { supervisorAlive: boolean; heartbeat: { ageMs: number } };
    expect(status.supervisorAlive).toBe(true);
    expect(status.heartbeat.ageMs).toBeLessThan(30_000);

    expect((await entry(['pause', runId], { cwd: repo, env })).code).toBe(0);
    const paused = await waitFor(
      async () => ((await store.readHeartbeat())?.phase === 'paused' ? true : undefined),
      10_000,
      'paused heartbeat',
    );
    expect(paused).toBe(true);
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
    expect(final.acceptedCommits).toBe(4);
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
