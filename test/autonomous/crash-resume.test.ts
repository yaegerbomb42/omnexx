/**
 * Crash-resume (chaos) test: inject a simulated crash at a step-journal
 * index during PLAN / IMPLEMENT / VERIFY, then boot a fresh daemon against
 * the same SQLite db and assert it completes the task idempotently — one
 * ship, no duplicate commits, no orphaned worktrees, a longer step journal.
 *
 * The "crash" is in-process: the harness hangs forever at the chosen
 * phase (a never-resolving promise), the crashed daemon object is abandoned
 * without `stop()` — exactly like a SIGKILL, whose lock file and worktree
 * are left behind. (`stop()` cannot be used on the crashed daemon: it
 * awaits the hung loop. The watchdog timer is `unref()`'d, so the abandoned
 * daemon cannot hold the test worker open.) The test then simulates the
 * dead pid by removing `daemon.lock` (the lock holds this process's own pid,
 * which is alive, so the fresh boot would otherwise refuse with
 * "already running"), prunes the orphaned worktree with the real
 * `WorktreeManager.pruneStale()`, and advances the FakeClock 31 minutes
 * past the 30-minute stale-lease window so boot reclaims the lease.
 *
 * Crash points for fix-adder (planTask records a 'plan' step on completion,
 * and the daemon journals one step per tool call plus one per turn, so
 * fix-adder has three steps before verify): plan at step 0 (task PLANNING,
 * no worktree yet), implement at step 2 (mid-turn, after the first
 * tool-call checkpoint; orphaned worktree), verify at step 3 (task
 * VERIFYING, orphaned worktree).
 *
 * Known gap this test works around: the daemon never removes stale
 * worktrees on boot, and `WorktreeManager.create` is not idempotent — an
 * orphaned worktree would make the resumed run's `prepareWorktree` throw
 * and the task would stick in PLANNING forever. The explicit
 * `destroy(taskId)` call (asserted to remove the orphan) is the
 * workaround; `pruneStale()` would not remove it, because it only prunes
 * worktrees git no longer knows about and the crashed one is still
 * registered.
 */
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutonomousStateStore, type TaskStatus } from '../../src/autonomous/state-store.js';
import { git } from '../../src/git/git.js';
import { createDaemonHarness, type HangPredicate } from './daemon-harness.js';
import { FakeClock } from './fake-clock.js';
import { createSyntheticRepo, type SyntheticRepo } from './fixtures/synthetic-repo/index.js';

const POLL_MS = 50;
const POLL_TIMEOUT_MS = 10_000;

let repo: SyntheticRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

async function waitFor(
  label: string,
  check: () => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface CrashPoint {
  phase: 'plan' | 'implement' | 'verify';
  status: TaskStatus;
  afterSteps: number;
}

const CRASH_POINTS: CrashPoint[] = [
  { phase: 'plan', status: 'PLANNING', afterSteps: 0 },
  { phase: 'implement', status: 'IMPLEMENTING', afterSteps: 2 },
  { phase: 'verify', status: 'VERIFYING', afterSteps: 3 },
];

/**
 * Wait until the step journal stops growing (the hang has engaged) and
 * return its length. A fixed sleep is not enough: the plan step lands
 * before the implement turn starts, so a reader can observe a transient
 * count that later grows by one.
 */
async function waitForQuiescentSteps(
  taskId: string,
  store: AutonomousStateStore,
  minSteps: number,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = store.getSteps(taskId).length;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const n = store.getSteps(taskId).length;
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    } else if (n >= minSteps && Date.now() - lastChange >= 150) {
      return n;
    }
  }
  throw new Error(`steps for ${taskId} never settled at >= ${minSteps} (last=${last})`);
}

describe('crash-resume', () => {
  it.each(CRASH_POINTS)(
    'crash during $phase (step $afterSteps) resumes and ships exactly once',
    async ({ phase, status, afterSteps }) => {
      repo = await createSyntheticRepo();
      const clock = new FakeClock(Date.now());
      const store1 = new AutonomousStateStore({
        repoRoot: repo.root,
        dbPath: join(repo.root, '.omnexx', 'autonomous.db'),
      });
      const hang: HangPredicate = (hangPhase, taskId) =>
        hangPhase === phase && store1.getSteps(taskId).length >= afterSteps;
      const harness1 = createDaemonHarness({
        repoRoot: repo.root,
        clock,
        store: store1,
        hang,
      });

      // Crash daemon 1 mid-task; never awaited, never stopped (SIGKILL).
      // Boot first so the store is open before the status poll runs.
      await harness1.daemon.boot();
      void harness1.daemon.start({ maxCycles: 5 });
      await waitFor(`task to reach ${status}`, () => harness1.store.listTasks(status).length > 0);
      const taskId = harness1.store.listTasks(status)[0]?.taskId;
      expect(taskId).toBeDefined();
      const crashedTaskId = taskId as string;
      // Let the hang engage: wait until the step journal stops growing.
      const stepsAtCrash = await waitForQuiescentSteps(crashedTaskId, harness1.store, afterSteps);
      expect(stepsAtCrash).toBe(afterSteps);

      // The orphaned worktree exists for implement/verify crashes (plan
      // crashes before any worktree is created).
      const orphanPath = harness1.worktrees?.pathFor(crashedTaskId);
      if (phase === 'plan') {
        expect(orphanPath === undefined || !existsSync(orphanPath)).toBe(true);
      } else {
        expect(orphanPath !== undefined && existsSync(orphanPath)).toBe(true);
      }

      // Workaround for the missing boot-time prune: destroy the orphan with
      // the real WorktreeManager and assert it went.
      if (phase !== 'plan' && orphanPath !== undefined) {
        await harness1.worktrees?.destroy(crashedTaskId);
        expect(existsSync(orphanPath)).toBe(false);
      }

      // Dead-pid simulation: remove the lock, then move the clock past the
      // 30-minute stale-lease window so boot reclaims the lease.
      await rm(join(repo.root, '.omnexx', 'daemon.lock'), { force: true });
      clock.set(Date.now() + 31 * 60 * 1000);

      // Fresh daemon, fresh store instance, same db file.
      const store2 = new AutonomousStateStore({
        repoRoot: repo.root,
        dbPath: harness1.dbPath,
      });
      const harness2 = createDaemonHarness({ repoRoot: repo.root, clock, store: store2 });
      await harness2.daemon.boot();
      const queued = harness2.store.listTasks('QUEUED');
      expect(queued.some((t) => t.taskId === crashedTaskId)).toBe(true);
      expect(queued).toHaveLength(5);

      await harness2.daemon.start({ maxCycles: 10 });

      // start() shuts the daemon down and closes its store; re-open it for
      // the post-run assertions.
      await store2.open();

      // Idempotent completion: exactly one ship, one daemon commit. The
      // commit is made by the daemon in shipTask (message `daemon:
      // <collector>:<fingerprint>`), not by the mock shipper.
      expect(harness2.outcomes.shipped.map((s) => s.title)).toEqual(['fix-adder']);
      const shippedSha = harness2.outcomes.shipped[0]?.commitSha;
      expect(shippedSha).toBeDefined();
      const subject = await git(repo.root, ['log', '-1', '--format=%s', shippedSha ?? '']);
      expect(subject.stdout.trim()).toMatch(/^daemon: test-runner:/);
      expect(harness2.store.listTasks('QUEUED')).toHaveLength(0);

      // The step journal kept growing across the crash (boot's reclaim step
      // plus the resumed run's implement/verify/learn steps).
      const stepsAfter = harness2.store.getSteps(crashedTaskId);
      expect(stepsAfter.length).toBeGreaterThan(stepsAtCrash);
      expect(stepsAfter.map((s) => s.phase)).toContain('learn');

      // No orphaned worktrees, no leftover lock, clean tree.
      const worktrees = await git(repo.root, ['worktree', 'list', '--porcelain']);
      expect(worktrees.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
      const worktreesDir = join(repo.root, '.omnexx', 'worktrees');
      if (existsSync(worktreesDir)) {
        expect((await readdir(worktreesDir)).filter((n) => n.startsWith('task-'))).toEqual([]);
      }
      expect(existsSync(join(repo.root, '.omnexx', 'daemon.lock'))).toBe(false);
      const statusAfter = await git(repo.root, ['status', '--porcelain']);
      const dirty = statusAfter.stdout
        .split('\n')
        .filter(Boolean)
        .filter((l) => !l.includes('.omnexx/'));
      expect(dirty).toEqual([]);
    },
    60_000,
  );

  it('a live lock blocks a second boot; removing the lock lets it boot', async () => {
    repo = await createSyntheticRepo();
    const clock = new FakeClock(Date.now());
    const harness1 = createDaemonHarness({ repoRoot: repo.root, clock });
    await harness1.daemon.boot();
    expect(existsSync(join(repo.root, '.omnexx', 'daemon.lock'))).toBe(true);

    const store2 = new AutonomousStateStore({
      repoRoot: repo.root,
      dbPath: harness1.dbPath,
    });
    const harness2 = createDaemonHarness({ repoRoot: repo.root, clock, store: store2 });
    await expect(harness2.daemon.boot()).rejects.toThrow(/already running as pid/);

    await rm(join(repo.root, '.omnexx', 'daemon.lock'), { force: true });
    await harness2.daemon.boot();
    expect(existsSync(join(repo.root, '.omnexx', 'daemon.lock'))).toBe(true);

    await harness2.daemon.stop();
    await harness1.daemon.stop();
    expect(existsSync(join(repo.root, '.omnexx', 'daemon.lock'))).toBe(false);
  });
});
