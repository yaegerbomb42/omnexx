import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { readLock } from '../../src/core/lock.js';
import { resolvePaths } from '../../src/core/paths.js';
import { listRunIds, RunStore, type RunState } from '../../src/core/run-store.js';
import { git } from '../../src/git/git.js';
import { isAncestor, isClean } from '../../src/git/repo.js';
import { parseTrailers } from '../../src/git/trailers.js';
import { entry, processRepo } from '../support/proc.js';

const ITERATIONS = Number(process.env.OMNEXX_CHAOS_ITERATIONS ?? 20);
const PHASES = [
  'planning',
  'select',
  'act',
  'verify',
  'commit',
  'rollback',
  'record',
  'guard',
] as const;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

async function trailerCommits(state: RunState): Promise<string[]> {
  const log = (
    await git(state.worktree, ['log', '--format=%B%x00', `${state.startRef}..${state.lastGreen}`])
  ).stdout;
  return log
    .split('\0')
    .map((m) => parseTrailers(m))
    .filter((t) => t !== undefined)
    .map((t) => `${t.task}@${t.cycle}`);
}

/** Invariants that must hold whenever no supervisor is running (plan §7.2). */
async function checkInvariants(store: RunStore, seenGreens: Set<string>): Promise<RunState> {
  const s = await store.readState();
  // No lost green commit: every lastGreen ever observed is still in the history of the current one.
  for (const g of seenGreens)
    expect(await isAncestor(s.worktree, g, s.lastGreen), `lost green ${g}`).toBe(true);
  seenGreens.add(s.lastGreen);
  for (const h of s.greenHistory)
    expect(await isAncestor(s.worktree, h.sha, s.lastGreen)).toBe(true);
  // No duplicate commit: each task is committed once (every task in these scenarios succeeds first try).
  const commits = await trailerCommits(s);
  const tasks = commits.map((c) => c.split('@')[0]);
  expect(new Set(tasks).size, `duplicate commits: ${commits.join(', ')}`).toBe(tasks.length);
  // state.json is consistent with git log.
  expect(s.acceptedCommits === commits.length || s.phase === 'commit').toBe(true);
  // Outside an in-flight cycle the worktree sits clean on lastGreen.
  if (['select', 'guard', 'record', 'planning', 'init', 'done'].includes(s.phase)) {
    expect((await git(s.worktree, ['rev-parse', 'HEAD'])).stdout).toBe(s.lastGreen);
    expect(await isClean(s.worktree)).toBe(true);
  }
  // Exactly one supervisor: none is alive now, and a leftover lock (from SIGKILL) is the only one.
  const lock = await readLock(store.dir);
  if (lock) expect(() => process.kill(lock.pid, 0)).toThrow();
  return s;
}

describe(`chaos: SIGKILL the supervisor at random phases, ${ITERATIONS} iterations`, () => {
  it.each(Array.from({ length: ITERATIONS }, (_, i) => i + 1))('seed %i', async (seed) => {
    const rand = rng(seed * 7919);
    const tasks = 3 + Math.floor(rand() * 4);
    const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: String(tasks) });
    const kills = Array.from(
      { length: 1 + Math.floor(rand() * 3) },
      () =>
        `${PHASES[Math.floor(rand() * PHASES.length)] ?? 'act'}:${1 + Math.floor(rand() * tasks)}`,
    );
    const seen = new Set<string>();

    const first = await entry(['run', `Create ${tasks} files`], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_KILL: kills[0] },
    });
    const [runId] = await listRunIds(resolvePaths(env));
    const store = new RunStore(resolvePaths(env), runId ?? '');
    if (first.code === 0) {
      await checkInvariants(store, seen);
      return;
    }
    await checkInvariants(store, seen);
    for (const [i, kill] of kills.slice(1).entries()) {
      const r = await entry(['supervise', runId ?? ''], {
        cwd: repo,
        env: { ...env, OMNEXX_TEST_KILL: kill, OMNEXX_TEST_BOOT_ID: `boot-${i}` },
      });
      await checkInvariants(store, seen);
      if (r.code === 0) break;
    }
    const last = await entry(['supervise', runId ?? ''], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_BOOT_ID: 'boot-final' },
    });
    expect(last.code, last.stderr).toBe(0);
    const final = await checkInvariants(store, seen);
    expect(final.status).toBe('finished');
    expect((await trailerCommits(final)).length).toBe(tasks);
    const resumes = (await readEvents(store.eventsPath)).filter(
      (e) => e.type === 'run.resume',
    ).length;
    expect(resumes).toBeGreaterThanOrEqual(1);
  });
});

describe('chaos: 30 tasks, 3 forced kills, one 10-minute API outage, zero manual steps', () => {
  it('finishes with 30 commits', async () => {
    const { repo, env } = await processRepo({
      OMNEXX_TEST_TASKS: '30',
      OMNEXX_TEST_OUTAGE_CYCLE: '12',
    });
    const seen = new Set<string>();
    let r = await entry(['run', 'Create 30 files'], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_KILL: 'act:5' },
    });
    expect(r.code).not.toBe(0);
    const [runId] = await listRunIds(resolvePaths(env));
    const store = new RunStore(resolvePaths(env), runId ?? '');
    await checkInvariants(store, seen);
    for (const [i, kill] of ['commit:14', 'record:22'].entries()) {
      // `resume --all` is exactly what the service runs after a crash or reboot.
      r = await entry(['resume', '--all'], {
        cwd: repo,
        env: { ...env, OMNEXX_TEST_KILL: kill, OMNEXX_TEST_BOOT_ID: `boot-${i}` },
      });
      expect(r.code).not.toBe(0);
      await checkInvariants(store, seen);
    }
    r = await entry(['resume', '--all'], {
      cwd: repo,
      env: { ...env, OMNEXX_TEST_BOOT_ID: 'boot-last' },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const s = await checkInvariants(store, seen);
    expect(s.status).toBe('finished');
    expect((await trailerCommits(s)).length).toBe(30);
    const events = await readEvents(store.eventsPath);
    expect(events.filter((e) => e.type === 'run.resume')).toHaveLength(3);
    // A 10-minute outage is retried with backoff (the run pauses, not fails); the 15-minute
    // outage notification threshold is not reached.
    expect(events.filter((e) => e.type === 'provider.retry').length).toBeGreaterThan(3);
    expect(events.filter((e) => e.type === 'provider.outage')).toHaveLength(0);
    expect(
      events.some((e) => e.type === 'provider.recovered' && Number(e.outageMs) >= 10 * 60_000),
    ).toBe(true);
  });

  it('a second supervisor for a live run is refused (exactly one supervisor)', async () => {
    const { repo, env } = await processRepo({ OMNEXX_TEST_TASKS: '3', OMNEXX_TEST_TURN_MS: '400' });
    const r = await entry(['run', '--detach', 'Create files'], { cwd: repo, env });
    const runId = r.stdout.trim();
    const store = new RunStore(resolvePaths(env), runId);
    for (let i = 0; i < 100 && !(await readLock(store.dir)); i++)
      await new Promise((res) => setTimeout(res, 100));
    const second = await entry(['supervise', runId], { cwd: repo, env });
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/already supervised by pid/);
    await entry(['stop', '--now', runId], { cwd: repo, env });
    for (let i = 0; i < 200 && (await readLock(store.dir)); i++)
      await new Promise((res) => setTimeout(res, 100));
    expect((await store.readState()).status).toBe('user-stop');
  });
});
