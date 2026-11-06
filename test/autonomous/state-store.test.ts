/**
 * State-store tests for the autonomous daemon (`src/autonomous/state-store.ts`).
 *
 * Covers the SQLite store directly: enqueue → pop → mark done, done-set
 * reads, tombstone strike escalation, cooldown expiry, the step journal,
 * and git-notes sync/hydration.
 *
 * Notes on the real implementation (vs the original brief):
 * - Tombstone escalation is 1h → 6h → 24h → 7d → permanent (strike 5),
 *   NOT 24h → 7d → permanent. `TOMBSTONE_COOLDOWNS_MS` is the source of truth.
 * - The store takes no Clock: it calls `Date.now()` internally. Cooldown
 *   expiry is tested through the explicit `nowMs` parameters
 *   (`isTombstoned(fp, nowMs)`, `cooldownUntilForStrike`), driven by a
 *   FakeClock, and through `cooldownUntilMs` deltas.
 * - `enqueueTask` does NOT consult the done-set: re-enqueuing a done
 *   fingerprint succeeds at the store level. Dedupe against the done-set /
 *   tombstones lives in `TriageEngine.triageFinding` (see triage.test.ts).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutonomousStateStore,
  cooldownUntilForStrike,
  globMatches,
  MAX_STRIKES_BEFORE_PERMANENT,
  TOMBSTONE_COOLDOWNS_MS,
  uuidv7,
  type EnqueueTaskInput,
} from '../../src/autonomous/state-store.js';
import { git } from '../../src/git/git.js';
import { tempDir, tempRepo } from '../support/tmp.js';
import { FakeClock } from './fake-clock.js';

const HOUR = 60 * 60 * 1000;

const taskInput = (fingerprint: string, priorityScore = 50): EnqueueTaskInput => ({
  fingerprint,
  sourceCollector: 'test-runner',
  priorityScore,
  targetFiles: ['src/adder.ts'],
  findingPayload: { test: 'adder adds' },
});

const tombstoneFailure = (stage = 'verify') => ({
  failureStage: stage,
  failureReason: 'tests still red',
  targetBlobHashes: { 'src/adder.ts': 'abc123' },
});

async function openMemoryStore(): Promise<AutonomousStateStore> {
  const store = new AutonomousStateStore({ repoRoot: await tempDir(), dbPath: ':memory:' });
  await store.open();
  return store;
}

describe('AutonomousStateStore — queue lifecycle', () => {
  let store: AutonomousStateStore;

  beforeEach(async () => {
    store = await openMemoryStore();
  });

  afterEach(() => {
    store.close();
  });

  it('enqueue → pop → mark done; pop claims highest priority first', () => {
    const low = store.enqueueTask(taskInput('fp-low', 10));
    const high = store.enqueueTask(taskInput('fp-high', 90));
    expect(low.status).toBe('QUEUED');
    expect(low.taskId).toMatch(/^[0-9a-f-]{36}$/);

    const popped = store.popNextTask();
    expect(popped?.fingerprint).toBe('fp-high');
    expect(popped?.status).toBe('PLANNING');
    expect(store.popNextTask()?.fingerprint).toBe('fp-low');
    expect(store.popNextTask()).toBeNull();

    const done = store.markDone(high.taskId, {
      deliveryMode: 'commit',
      targetBlobHashes: { 'src/adder.ts': 'abc123' },
      shippedCommitSha: 'deadbeef',
    });
    expect(done?.fingerprint).toBe('fp-high');
    expect(store.isDone('fp-high')).toBe(true);
    expect(store.getTask(high.taskId)).toBeNull();
    expect(store.getDoneEntry('fp-high')?.shippedCommitSha).toBe('deadbeef');
  });

  it('markDone on an unknown task returns null; methods throw before open()', async () => {
    expect(
      store.markDone('no-such-task', { deliveryMode: 'commit', targetBlobHashes: {} }),
    ).toBeNull();
    const closed = new AutonomousStateStore({ repoRoot: await tempDir(), dbPath: ':memory:' });
    expect(() => closed.isDone('fp')).toThrow(/not open/);
    await closed.open();
    expect(closed.isOpen).toBe(true);
    await closed.open(); // idempotent
    closed.close();
    expect(closed.isOpen).toBe(false);
  });

  it('re-enqueueing the same fingerprint returns the existing row (INSERT OR IGNORE)', () => {
    const first = store.enqueueTask(taskInput('fp-dup', 40));
    const second = store.enqueueTask(taskInput('fp-dup', 99));
    expect(second.taskId).toBe(first.taskId);
    expect(store.listTasks()).toHaveLength(1);
  });

  it('re-enqueue after markDone succeeds at the store level (dedupe is triage’s job)', () => {
    const task = store.enqueueTask(taskInput('fp-redo', 40));
    store.popNextTask();
    store.markDone(task.taskId, { deliveryMode: 'commit', targetBlobHashes: {} });
    expect(store.isDone('fp-redo')).toBe(true);
    const again = store.enqueueTask(taskInput('fp-redo', 40));
    expect(again.status).toBe('QUEUED');
    expect(store.isDone('fp-redo')).toBe(true); // done-set row untouched
  });

  it('updateTaskStatus + addTaskUsage track attempts, tokens and turns', () => {
    const task = store.enqueueTask(taskInput('fp-usage', 10));
    store.addTaskUsage(task.taskId, { tokens: 100, turns: 2, attempts: 1 });
    const updated = store.updateTaskStatus(task.taskId, 'IMPLEMENTING', { plan: { steps: 1 } });
    expect(updated?.status).toBe('IMPLEMENTING');
    expect(updated?.tokensSpent).toBe(100);
    expect(updated?.turnsSpent).toBe(2);
    expect(updated?.attemptCount).toBe(1);
    expect((updated?.plan as { steps: number } | null)?.steps).toBe(1);
    expect(store.updateTaskStatus('missing', 'QUEUED')).toBeNull();
  });

  it('step journal appends in order with per-task indices', () => {
    const task = store.enqueueTask(taskInput('fp-steps', 10));
    const s0 = store.recordStep(task.taskId, { phase: 'PLAN', toolName: 'planner' });
    const s1 = store.recordStep(task.taskId, {
      phase: 'IMPLEMENT',
      toolName: 'edit_file',
      gitTreeHash: 'tree1',
      tokensDelta: 50,
    });
    const s2 = store.recordStep(task.taskId, {
      phase: 'VERIFY',
      errorSignature: 'boom',
    });
    expect([s0.stepIndex, s1.stepIndex, s2.stepIndex]).toEqual([0, 1, 2]);
    const steps = store.getSteps(task.taskId);
    expect(steps.map((s) => s.phase)).toEqual(['PLAN', 'IMPLEMENT', 'VERIFY']);
    expect(steps[1]?.gitTreeHash).toBe('tree1');
    expect(steps[1]?.tokensDelta).toBe(50);
    expect(steps[2]?.errorSignature).toBe('boom');
    expect(store.getSteps('no-such-task')).toEqual([]);
  });

  it('filesTouchedSince sees files shipped or in flight recently', () => {
    const task = store.enqueueTask(taskInput('fp-touch', 10));
    store.popNextTask();
    store.markDone(task.taskId, {
      deliveryMode: 'commit',
      targetBlobHashes: { 'src/adder.ts': 'abc123' },
    });
    const since = Date.now() - 1000;
    expect(store.filesTouchedSince(['src/adder.ts'], since)).toBe(true);
    expect(store.filesTouchedSince(['src/other.ts'], since)).toBe(false);
    expect(store.filesTouchedSince(['src/adder.ts'], Date.now() + HOUR)).toBe(false);
    expect(store.filesTouchedSince([], since)).toBe(false);
  });
});

describe('AutonomousStateStore — tombstones and cooldowns', () => {
  let store: AutonomousStateStore;

  beforeEach(async () => {
    store = await openMemoryStore();
  });

  afterEach(() => {
    store.close();
  });

  it('strike escalation is 1h → 6h → 24h → 7d → permanent', () => {
    expect(TOMBSTONE_COOLDOWNS_MS).toEqual([HOUR, 6 * HOUR, 24 * HOUR, 7 * 24 * HOUR]);
    expect(MAX_STRIKES_BEFORE_PERMANENT).toBe(5);
    const clock = new FakeClock(Date.now());
    expect(cooldownUntilForStrike(1, clock.now())).toBe(clock.now() + HOUR);
    expect(cooldownUntilForStrike(2, clock.now())).toBe(clock.now() + 6 * HOUR);
    expect(cooldownUntilForStrike(3, clock.now())).toBe(clock.now() + 24 * HOUR);
    expect(cooldownUntilForStrike(4, clock.now())).toBe(clock.now() + 7 * 24 * HOUR);
    expect(cooldownUntilForStrike(5, clock.now())).toBe(-1);
    expect(cooldownUntilForStrike(99, clock.now())).toBe(-1);
  });

  it('tombstone() increments strikes and lengthens the cooldown each time', () => {
    const before = Date.now();
    const first = store.tombstone({ fingerprint: 'fp-t', failure: tombstoneFailure() });
    expect(first.strikeCount).toBe(1);
    expect(first.cooldownUntilMs - before).toBeGreaterThanOrEqual(HOUR - 5000);
    expect(first.cooldownUntilMs - before).toBeLessThanOrEqual(HOUR + 5000);

    const second = store.tombstone({ fingerprint: 'fp-t', failure: tombstoneFailure() });
    expect(second.strikeCount).toBe(2);
    expect(second.cooldownUntilMs - before).toBeGreaterThanOrEqual(6 * HOUR - 5000);

    store.tombstone({ fingerprint: 'fp-t', failure: tombstoneFailure() });
    store.tombstone({ fingerprint: 'fp-t', failure: tombstoneFailure() });
    const fifth = store.tombstone({ fingerprint: 'fp-t', failure: tombstoneFailure() });
    expect(fifth.strikeCount).toBe(5);
    expect(fifth.cooldownUntilMs).toBe(-1);
  });

  it('isTombstoned honours cooldown expiry via an explicit nowMs (FakeClock-driven)', () => {
    const clock = new FakeClock(Date.now());
    const entry = store.tombstone({ fingerprint: 'fp-exp', failure: tombstoneFailure() });
    expect(entry.cooldownUntilMs).toBeGreaterThan(clock.now());

    clock.set(entry.cooldownUntilMs - 1000);
    expect(store.isTombstoned('fp-exp', clock.now())).toBe(true);
    clock.set(entry.cooldownUntilMs + 1000);
    expect(store.isTombstoned('fp-exp', clock.now())).toBe(false);
    expect(store.isTombstoned('fp-never', clock.now())).toBe(false);

    // Strike 5 is permanent: no amount of virtual time lifts it.
    for (let i = 0; i < 4; i++) {
      store.tombstone({ fingerprint: 'fp-exp', failure: tombstoneFailure() });
    }
    clock.advance(365 * 24 * HOUR);
    expect(store.isTombstoned('fp-exp', clock.now())).toBe(true);
    store.clearTombstone('fp-exp');
    expect(store.isTombstoned('fp-exp', clock.now())).toBe(false);
  });

  it('tombstone removes the task from the queue when taskId is known', () => {
    const task = store.enqueueTask(taskInput('fp-q', 10));
    store.tombstone({ taskId: task.taskId, fingerprint: 'fp-q', failure: tombstoneFailure() });
    expect(store.getTask(task.taskId)).toBeNull();
    expect(store.getTombstone('fp-q')?.failureReason).toBe('tests still red');
  });

  it('isTombstoneUnlocked: expired cooldown or changed blobs unlock; live cooldown does not', async () => {
    const repoRoot = await tempRepo();
    await writeFile(join(repoRoot, 'src-adder.txt'), 'v1');
    const store2 = new AutonomousStateStore({ repoRoot, dbPath: ':memory:' });
    await store2.open();
    try {
      const entry = store2.tombstone({
        fingerprint: 'fp-unlock',
        failure: { ...tombstoneFailure(), targetBlobHashes: { 'src-adder.txt': 'deadbeef' } },
      });
      // Live cooldown + blobs differ from the (bogus) recorded hash → blobsChanged
      // reports a change, so the tombstone is unlocked by external invalidation.
      expect(store2.isTombstoneUnlocked('fp-unlock', repoRoot)).toBe(true);
      // With matching blobs recorded, the live cooldown holds.
      const hash = (await git(repoRoot, ['hash-object', '--', 'src-adder.txt'])).stdout.trim();
      store2.clearTombstone('fp-unlock');
      store2.tombstone({
        fingerprint: 'fp-unlock',
        failure: { ...tombstoneFailure(), targetBlobHashes: { 'src-adder.txt': hash } },
      });
      expect(store2.isTombstoneUnlocked('fp-unlock', repoRoot)).toBe(false);
      expect(store2.isTombstoneUnlocked('fp-unlock', repoRoot, entry.cooldownUntilMs + 1000)).toBe(
        true,
      );
      expect(store2.isTombstoneUnlocked('fp-unknown', repoRoot)).toBe(true);
    } finally {
      store2.close();
    }
  });
});

describe('AutonomousStateStore — patterns, flaky tests, budget, discarded', () => {
  let store: AutonomousStateStore;

  beforeEach(async () => {
    store = await openMemoryStore();
  });

  afterEach(() => {
    store.close();
  });

  it('learned patterns: glob scope, confidence clamp, 600-char summary cap', () => {
    const long = 'x'.repeat(1000);
    const pattern = store.recordPattern({
      scopeGlob: 'src/**/*.ts',
      patternType: 'ANTI_PATTERN',
      ruleSummary: long,
      confidence: 1.5,
    });
    expect(pattern.confidence).toBe(1);
    expect(pattern.ruleSummary.length).toBeLessThanOrEqual(600);
    expect(store.getLearnedPatterns('src/adder.ts')).toHaveLength(1);
    expect(store.getLearnedPatterns('test/adder.test.ts')).toHaveLength(0);
    store.recordPattern({
      scopeGlob: 'src/adder.ts',
      patternType: 'INVARIANT',
      ruleSummary: 'exact',
      confidence: 0.1,
    });
    expect(store.getLearnedPatterns('src/adder.ts')).toHaveLength(2);
  });

  it('flaky tests quarantine at a 30% flake rate, not below', () => {
    const hot = store.recordFlakyTest('flaky-a', 0.5);
    expect(hot.quarantinedAtMs).not.toBeNull();
    const cold = store.recordFlakyTest('flaky-b', 0.1);
    expect(cold.quarantinedAtMs).toBeNull();
    const forced = store.recordFlakyTest('flaky-b', 0.1, { quarantine: true });
    expect(forced.quarantinedAtMs).not.toBeNull();
    expect(store.getFlakyTests().map((f) => f.testId)).toEqual(['flaky-a', 'flaky-b']);
  });

  it('budget ledger accumulates spend per window key', () => {
    const first = store.recordBudgetSpend('2026-11-06', 100, 0.5);
    expect(first.tokensSpent).toBe(100);
    const second = store.recordBudgetSpend('2026-11-06', 50, 0.25);
    expect(second.tokensSpent).toBe(150);
    expect(second.costUsd).toBeCloseTo(0.75);
    expect(store.getBudgetWindow('missing')).toBeNull();
  });

  it('discarded findings round-trip', () => {
    store.recordDiscardedFinding({
      fingerprint: 'fp-disc',
      sourceCollector: 'todo-mining',
      priorityScore: 12.5,
      reason: 'below threshold',
      findingPayload: { text: 'TODO: fix later' },
    });
    const found = store.getDiscardedFinding('fp-disc');
    expect(found?.reason).toBe('below threshold');
    expect(found?.priorityScore).toBe(12.5);
    expect(store.getDiscardedFinding('missing')).toBeNull();
  });
});

describe('AutonomousStateStore — persistence and git notes', () => {
  it('done-set and tombstones survive close/reopen of a file-backed db', async () => {
    const dir = await tempDir();
    const dbPath = join(dir, 'autonomous.db');
    const first = new AutonomousStateStore({ repoRoot: dir, dbPath });
    await first.open();
    const task = first.enqueueTask(taskInput('fp-persist', 10));
    first.popNextTask();
    first.markDone(task.taskId, { deliveryMode: 'commit', targetBlobHashes: {} });
    first.tombstone({ fingerprint: 'fp-persist-t', failure: tombstoneFailure() });
    first.close();

    const second = new AutonomousStateStore({ repoRoot: dir, dbPath });
    await second.open();
    try {
      expect(second.isDone('fp-persist')).toBe(true);
      expect(second.getDoneEntry('fp-persist')?.deliveryMode).toBe('commit');
      expect(second.getTombstone('fp-persist-t')?.strikeCount).toBe(1);
      expect(second.listTasks()).toHaveLength(0);
    } finally {
      second.close();
    }
  });

  it('git-notes receipts round-trip: sync then hydrate into a fresh store', async () => {
    const repoRoot = await tempRepo();
    await writeFile(join(repoRoot, 'a.txt'), 'hello\n');
    await git(repoRoot, ['add', '-A']);
    await git(repoRoot, ['commit', '-q', '-m', 'initial']);
    const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();

    const writer = new AutonomousStateStore({ repoRoot, dbPath: ':memory:' });
    await writer.open();
    try {
      const ok = await writer.syncReceiptToGitNotes('fp-notes', 'done', head, {
        deliveryMode: 'commit',
        targetBlobHashes: { 'a.txt': 'x' },
      });
      expect(ok).toBe(true);
      expect(await writer.syncReceiptToGitNotes('fp-missing', 'done', '0'.repeat(40))).toBe(false);
    } finally {
      writer.close();
    }

    const reader = new AutonomousStateStore({ repoRoot, dbPath: ':memory:' });
    await reader.open();
    try {
      const counts = await reader.hydrateFromGitNotes();
      expect(counts.done).toBe(1);
      expect(reader.isDone('fp-notes')).toBe(true);
      const again = await reader.hydrateFromGitNotes();
      expect(again.done).toBe(0); // local rows win; already present
      expect(again.skipped).toBe(1);
    } finally {
      reader.close();
    }
  });
});

describe('uuidv7', () => {
  it('produces unique version-7 UUIDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('globMatches', () => {
  it('matches * within a segment, ** across segments, and ? for one char', () => {
    expect(globMatches('*.ts', 'src/adder.ts')).toBe(false); // * does not cross /
    expect(globMatches('src/*.ts', 'src/adder.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/deep/adder.ts')).toBe(false);
    expect(globMatches('src/**/*.ts', 'src/adder.ts')).toBe(true);
    expect(globMatches('src/**/*.ts', 'src/deep/adder.ts')).toBe(true);
    expect(globMatches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/?.ts', 'src/ab.ts')).toBe(false);
    expect(globMatches('**', 'src/deep/adder.ts')).toBe(true);
    expect(globMatches('src/adder.ts', 'src/other.ts')).toBe(false);
  });
});
