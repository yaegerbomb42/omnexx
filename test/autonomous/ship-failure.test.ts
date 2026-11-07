/**
 * Ship-failure states + boot reclaim (the 2026-11-06 live-test failures).
 *
 * (A) Tier 2 ship: `gh pr create` failed AFTER the branch was pushed. The
 * old daemon treated "no PR URL" as "not shipped", returned from the ship
 * step without recording anything terminal, and moved on to the next task —
 * leaving the task stuck in VERIFYING with an empty done_set, the outcome
 * recorded only in a journal line. The fix: the shipper reports an explicit
 * `outcome`, and the daemon marks branch-pushed/PR-failed done-with-caveat
 * (`deliveryMode: 'auto:branch-only'`, branch + PR-body path in the step
 * journal, review-queue entry already written by the shipper) and
 * quarantines a task whose branch push itself failed.
 *
 * (B) Boot reclaim: tasks stuck in PLANNING / IMPLEMENTING / VERIFYING
 * after a crash were only reclaimed at boot, so a task orphaned while the
 * daemon stayed alive was never reclaimed until the next restart. Reclaim
 * now also runs at the top of every cycle (at a cycle boundary no task is
 * in flight, so any ACTIVE task seen there is necessarily orphaned).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readReviewQueue } from '../../src/autonomous/state.js';
import { git } from '../../src/git/git.js';
import { createDaemonHarness } from './daemon-harness.js';
import { FakeClock } from './fake-clock.js';
import { createSyntheticRepo, type SyntheticRepo } from './fixtures/synthetic-repo/index.js';

let repo: SyntheticRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

describe('ship failure states', () => {
  it('branch pushed but PR creation failed lands done-with-caveat, not VERIFYING', async () => {
    repo = await createSyntheticRepo();
    const clock = new FakeClock(Date.now());
    const harness = createDaemonHarness({
      repoRoot: repo.root,
      clock,
      scenarios: ['fix-adder'],
      shipMode: 'branch-pushed-pr-failed',
    });
    await harness.daemon.start({ maxCycles: 1 });
    await harness.store.open();

    // Terminal state: done, with the caveat in the delivery mode — the
    // task is gone from the work queue (nothing stuck in VERIFYING) and
    // there is no tombstone for it.
    const doneEntries = harness.store.listDone();
    expect(doneEntries).toHaveLength(1);
    const done = doneEntries[0];
    expect(done?.deliveryMode).toBe('auto:branch-only');
    expect(done?.fingerprint).toBeDefined();
    expect(harness.store.listTasks()).toHaveLength(0);
    expect(done ? harness.store.getTombstone(done.fingerprint) : undefined).toBeNull();

    // The branch + PR-body path are recorded where a human can act on
    // them: the ship step in the journal, and the review queue (branch
    // with no PR URL — `review approve` already tells the operator the
    // branch is ready with no PR opened for it).
    const taskId = done?.taskId ?? '';
    const shipSteps = harness.store.getSteps(taskId).filter((s) => s.phase === 'ship');
    expect(shipSteps).toHaveLength(1);
    const shipNote = shipSteps[0]?.errorSignature ?? '';
    expect(shipNote).toContain('branch_pushed_pr_failed');
    expect(shipNote).toContain(`omnexx/auto/${taskId}`);
    expect(shipNote).toContain('pr-bodies');
    const prBodyPath = join(repo.root, '.omnexx', 'pr-bodies', `${taskId}.md`);
    expect(shipNote).toContain(prBodyPath);
    expect(existsSync(prBodyPath)).toBe(true);
    const review = readReviewQueue(join(repo.root, '.omnexx', 'review-queue.json'));
    expect(review).toHaveLength(1);
    expect(review[0]?.taskId).toBe(taskId);
    expect(review[0]?.branch).toBe(`omnexx/auto/${taskId}`);
    expect(review[0]?.prUrl).toBeUndefined();

    // Nothing was merged to main: the work lives on the branch, not in
    // the tree the daemon merged.
    const mainAdder = await git(repo.root, ['show', 'main:src/adder.ts']);
    expect(mainAdder.stdout).toContain('return a - b;');
    expect(harness.outcomes.shipped).toHaveLength(0);
  }, 60_000);

  it('branch push itself failed quarantines the task instead of orphaning it', async () => {
    repo = await createSyntheticRepo();
    const clock = new FakeClock(Date.now());
    const harness = createDaemonHarness({
      repoRoot: repo.root,
      clock,
      scenarios: ['fix-adder'],
      shipMode: 'push-failed',
    });
    await harness.daemon.start({ maxCycles: 1 });
    await harness.store.open();

    // Nothing shipped, so nothing is done — but the task is visible as a
    // tombstone (stage `ship`, reason names the push failure) instead of
    // sitting in VERIFYING forever.
    expect(harness.store.listDone()).toHaveLength(0);
    expect(harness.store.listTasks()).toHaveLength(0);
    const taskId = harness.outcomes.titlesById.keys().next().value ?? '';
    const fingerprint = harness.outcomes.titlesById.get(taskId)?.fingerprint;
    expect(fingerprint).toBeDefined();
    const tomb = fingerprint ? harness.store.getTombstone(fingerprint) : null;
    expect(tomb).not.toBeNull();
    expect(tomb?.failureStage).toBe('ship');
    expect(tomb?.failureReason).toContain('ship_push_failed');
    const phases = harness.store.getSteps(taskId).map((s) => s.phase);
    expect(phases).toContain('quarantine');

    // No review-queue entry: nothing reached the remote. The PR body is
    // still on disk for a human.
    expect(readReviewQueue(join(repo.root, '.omnexx', 'review-queue.json'))).toHaveLength(0);
    expect(existsSync(join(repo.root, '.omnexx', 'pr-bodies', `${taskId}.md`))).toBe(true);
    const mainAdder = await git(repo.root, ['show', 'main:src/adder.ts']);
    expect(mainAdder.stdout).toContain('return a - b;');
  }, 60_000);
});

describe('boot / cycle stale-lease reclaim', () => {
  it('reclaims a task stuck in VERIFYING with a stale lease on boot', async () => {
    repo = await createSyntheticRepo();
    const clock = new FakeClock(Date.now());
    const harness = createDaemonHarness({ repoRoot: repo.root, clock });
    await harness.store.open();
    const task = harness.store.enqueueTask({
      fingerprint: 'reclaim-verify',
      sourceCollector: 'test-runner',
      priorityScore: 0.9,
      targetFiles: ['src/adder.ts'],
      findingPayload: { ruleOrTestId: 'scenario:fix-adder', kind: 'failing-test' },
    });
    harness.store.updateTaskStatus(task.taskId, 'VERIFYING');
    expect(harness.store.listTasks('VERIFYING')).toHaveLength(1);

    // 31 minutes past the 30-minute lease, then boot.
    clock.set(Date.now() + 31 * 60 * 1000);
    await harness.daemon.boot();
    expect(harness.store.listTasks('VERIFYING')).toHaveLength(0);
    const queued = harness.store.listTasks('QUEUED');
    expect(queued.some((t) => t.taskId === task.taskId)).toBe(true);
    await harness.daemon.stop();
  });

  it('does not reclaim a task stuck in VERIFYING with a fresh lease on boot', async () => {
    repo = await createSyntheticRepo();
    const clock = new FakeClock(Date.now());
    const harness = createDaemonHarness({ repoRoot: repo.root, clock });
    await harness.store.open();
    const task = harness.store.enqueueTask({
      fingerprint: 'reclaim-fresh',
      sourceCollector: 'test-runner',
      priorityScore: 0.9,
      targetFiles: ['src/adder.ts'],
      findingPayload: { ruleOrTestId: 'scenario:fix-adder', kind: 'failing-test' },
    });
    harness.store.updateTaskStatus(task.taskId, 'VERIFYING');

    await harness.daemon.boot();
    expect(harness.store.listTasks('VERIFYING').map((t) => t.taskId)).toEqual([task.taskId]);
    expect(harness.store.listTasks('QUEUED')).toHaveLength(0);
    await harness.daemon.stop();
  });

  it('reclaims a stale VERIFYING task at a cycle boundary and completes it', async () => {
    repo = await createSyntheticRepo();
    const clock = new FakeClock(Date.now());
    const harness = createDaemonHarness({ repoRoot: repo.root, clock });
    await harness.store.open();
    const task = harness.store.enqueueTask({
      fingerprint: 'reclaim-cycle',
      sourceCollector: 'test-runner',
      priorityScore: 0.9,
      targetFiles: ['src/adder.ts'],
      findingPayload: { ruleOrTestId: 'scenario:fix-adder', kind: 'failing-test' },
    });
    harness.store.updateTaskStatus(task.taskId, 'VERIFYING');

    // Boot while the lease is fresh: no reclaim. Then 31 minutes pass
    // with the daemon alive — the next cycle reclaims the orphan and
    // runs it to completion without any restart.
    await harness.daemon.boot();
    expect(harness.store.listTasks('VERIFYING')).toHaveLength(1);
    clock.set(Date.now() + 31 * 60 * 1000);
    await harness.daemon.runCycle();

    const done = harness.store.getDoneEntry('reclaim-cycle');
    expect(done).not.toBeNull();
    expect(done?.deliveryMode).toBe('auto');
    expect(harness.store.listTasks()).toHaveLength(0);
    const mainAdder = await git(repo.root, ['show', 'main:src/adder.ts']);
    expect(mainAdder.stdout).toContain('return a + b;');
    await harness.daemon.stop();
  }, 60_000);
});
