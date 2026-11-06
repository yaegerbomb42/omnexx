/**
 * Triage tests for the autonomous daemon (`src/autonomous/triage.ts`).
 *
 * PriorityScore = (35*severity + 25*confidence + 25*verification + 15*hotness)
 *                 / (1 + 0.6*blastRadius + 0.4*tokenCost)
 *                 * cooldownMultiplier
 * Admission threshold is 32.0; the cooldown multiplier is 0.25 when an
 * autonomous task touched a target file in the last 6h.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutonomousStateStore } from '../../src/autonomous/state-store.js';
import {
  COOLDOWN_MULTIPLIER,
  COOLDOWN_WINDOW_MS,
  computePriorityScore,
  MIN_ADMISSION_SCORE,
  severityForKind,
  TriageEngine,
  type RawFinding,
  type ScoreInput,
} from '../../src/autonomous/triage.js';
import { tempRepo } from '../support/tmp.js';
import { FakeClock } from './fake-clock.js';

const base: ScoreInput = {
  severity: 1,
  confidence: 1,
  verification: 1,
  hotness: 1,
  blastRadius: 0,
  tokenCost: 0,
  cooldownActive: false,
};

describe('computePriorityScore', () => {
  it('scores a perfect finding at 100', () => {
    expect(computePriorityScore(base)).toBe(100);
  });

  it('failing test with strong signals scores above the 32 threshold', () => {
    // severity 1.0 (failing-test) — numerator 35 + 22.5 + 25 + 12 = 94.5,
    // denominator 1 + 0.12 + 0.12 = 1.24 → 76.21.
    const score = computePriorityScore({
      severity: severityForKind('failing-test'),
      confidence: 0.9,
      verification: 1.0,
      hotness: 0.8,
      blastRadius: 0.2,
      tokenCost: 0.3,
      cooldownActive: false,
    });
    expect(score).toBeCloseTo(76.21, 2);
    expect(score).toBeGreaterThan(MIN_ADMISSION_SCORE);
  });

  it('TODO with weak signals scores below the 32 threshold', () => {
    // severity 0.2 (todo) — numerator 7 + 12.5 + 7.5 + 3 = 30,
    // denominator 1 + 0.3 + 0.32 = 1.62 → 18.52.
    const score = computePriorityScore({
      severity: severityForKind('todo'),
      confidence: 0.5,
      verification: 0.3,
      hotness: 0.2,
      blastRadius: 0.5,
      tokenCost: 0.8,
      cooldownActive: false,
    });
    expect(score).toBeCloseTo(18.52, 2);
    expect(score).toBeLessThan(MIN_ADMISSION_SCORE);
  });

  it('cooldown multiplier is exactly 0.25', () => {
    expect(COOLDOWN_MULTIPLIER).toBe(0.25);
    expect(computePriorityScore({ ...base, cooldownActive: true })).toBe(25);
    expect(computePriorityScore({ ...base, cooldownActive: true })).toBe(
      computePriorityScore(base) * 0.25,
    );
    // A failing test that would score 76.21 drops to ~19.05 under cooldown.
    const cooled = computePriorityScore({
      severity: 1,
      confidence: 0.9,
      verification: 1,
      hotness: 0.8,
      blastRadius: 0.2,
      tokenCost: 0.3,
      cooldownActive: true,
    });
    expect(cooled).toBeCloseTo(19.05, 2);
    expect(cooled).toBeLessThan(MIN_ADMISSION_SCORE);
  });

  it('blast-radius penalty: a high-import file scores lower than a low-import one', () => {
    const lowBlast = computePriorityScore({ ...base, blastRadius: 0 });
    const midBlast = computePriorityScore({ ...base, blastRadius: 0.5 });
    const highBlast = computePriorityScore({ ...base, blastRadius: 1 });
    expect(lowBlast).toBe(100);
    expect(midBlast).toBeCloseTo(100 / 1.3, 10);
    expect(highBlast).toBe(100 / 1.6);
    expect(highBlast).toBeLessThan(midBlast);
    expect(midBlast).toBeLessThan(lowBlast);
    // Token cost penalises the same way, independently.
    expect(computePriorityScore({ ...base, tokenCost: 1 })).toBe(100 / 1.4);
  });

  it('clamps every 0..1 input before scoring', () => {
    expect(computePriorityScore({ ...base, severity: 2 })).toBe(100);
    expect(computePriorityScore({ ...base, blastRadius: -1 })).toBe(100);
    expect(computePriorityScore({ ...base, confidence: 0, verification: 0, hotness: 0 })).toBe(35);
  });

  it('severity weights rank failing-test above todo', () => {
    expect(severityForKind('failing-test')).toBe(1.0);
    expect(severityForKind('cve')).toBe(1.0);
    expect(severityForKind('type-error')).toBe(0.9);
    expect(severityForKind('todo')).toBe(0.2);
    expect(severityForKind('failing-test')).toBeGreaterThan(severityForKind('todo'));
    expect(COOLDOWN_WINDOW_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('TriageEngine', () => {
  let repoRoot: string;
  let store: AutonomousStateStore;
  let engine: TriageEngine;
  let clock: FakeClock;

  const failingTest: RawFinding = {
    collector: 'test-runner',
    ruleOrTestId: 'adder adds',
    targetFiles: ['src/adder.ts'],
    kind: 'failing-test',
    confidence: 0.9,
    verification: 1.0,
    hotness: 0.8,
    blastRadius: 0.2,
    tokenCost: 0.3,
  };

  beforeEach(async () => {
    repoRoot = await tempRepo();
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    await writeFile(
      join(repoRoot, 'src/adder.ts'),
      'export const add = (a: number, b: number): number => a + b;\n',
    );
    await writeFile(join(repoRoot, 'src/other.ts'), 'export const x = 1;\n');
    store = new AutonomousStateStore({ repoRoot, dbPath: ':memory:' });
    await store.open();
    clock = new FakeClock(Date.now());
    engine = new TriageEngine(store, { repoRoot, now: () => clock.now() });
  });

  afterEach(() => {
    store.close();
  });

  it('admits a failing test above threshold and enqueues it once', () => {
    const first = engine.triageFinding(failingTest);
    expect(first.decision).toBe('admitted');
    if (first.decision !== 'admitted') throw new Error('expected admitted');
    expect(first.score).toBeCloseTo(76.21, 2);
    expect(first.task.priorityScore).toBeCloseTo(76.21, 2);
    expect(store.listTasks()).toHaveLength(1);

    // Re-triage before completion re-admits the same fingerprint (no duplicate row).
    const second = engine.triageFinding(failingTest);
    expect(second.decision).toBe('admitted');
    expect(store.listTasks()).toHaveLength(1);
  });

  it('done-set blocks re-queue: the same finding becomes a duplicate after markDone', () => {
    const admitted = engine.triageFinding(failingTest);
    if (admitted.decision !== 'admitted') throw new Error('expected admitted');
    const task = store.getTaskByFingerprint(admitted.fingerprint);
    if (task === null) throw new Error('expected queued task');
    store.popNextTask();
    store.markDone(task.taskId, { deliveryMode: 'commit', targetBlobHashes: {} });

    const again = engine.triageFinding(failingTest);
    expect(again.decision).toBe('duplicate');
    if (again.decision !== 'duplicate') throw new Error('expected duplicate');
    expect(again.score).toBe(0);
    expect(again.reason).toMatch(/done_set/);
    expect(store.listTasks()).toHaveLength(0);
  });

  it('tombstoned fingerprints are refused while cooling down', () => {
    const admitted = engine.triageFinding(failingTest);
    if (admitted.decision !== 'admitted') throw new Error('expected admitted');
    store.tombstone({
      fingerprint: admitted.fingerprint,
      failure: {
        failureStage: 'verify',
        failureReason: 'tests still red',
        targetBlobHashes: {},
      },
    });
    const again = engine.triageFinding(failingTest);
    expect(again.decision).toBe('tombstoned');
    if (again.decision !== 'tombstoned') throw new Error('expected tombstoned');
    expect(again.reason).toMatch(/strike 1/);
  });

  it('a weak TODO is discarded and logged, not enqueued', () => {
    const todo: RawFinding = {
      collector: 'todo-mining',
      ruleOrTestId: 'TODO: refactor later',
      targetFiles: ['src/other.ts'],
      kind: 'todo',
      confidence: 0.5,
      verification: 0.3,
      hotness: 0.2,
      blastRadius: 0.5,
      tokenCost: 0.8,
    };
    const decision = engine.triageFinding(todo);
    expect(decision.decision).toBe('discarded');
    if (decision.decision !== 'discarded') throw new Error('expected discarded');
    expect(decision.score).toBeCloseTo(18.52, 2);
    expect(store.listTasks()).toHaveLength(0);
    expect(store.getDiscardedFinding(decision.fingerprint)?.reason).toMatch(/below admission/);
  });

  it('scoreTask applies the 0.25 churn guard when a target file was recently touched', () => {
    // Ship something touching src/adder.ts, then score a new finding on it.
    const task = store.enqueueTask({
      fingerprint: 'fp-shipped',
      sourceCollector: 'test-runner',
      priorityScore: 90,
      targetFiles: ['src/adder.ts'],
      findingPayload: {},
    });
    store.popNextTask();
    store.markDone(task.taskId, {
      deliveryMode: 'commit',
      targetBlobHashes: { 'src/adder.ts': 'abc' },
    });

    const cooled = engine.scoreTask(engine.toCandidate(failingTest));
    const fresh = engine.scoreTask(
      engine.toCandidate({ ...failingTest, targetFiles: ['src/other.ts'] }),
    );
    expect(cooled).toBeCloseTo(fresh * 0.25, 10);
    expect(cooled).toBeLessThan(MIN_ADMISSION_SCORE);

    // Past the 6h window the guard lifts.
    clock.advance(COOLDOWN_WINDOW_MS + 1000);
    const uncooled = engine.scoreTask(engine.toCandidate(failingTest));
    expect(uncooled).toBeCloseTo(fresh, 10);
  });

  it('toCandidate fingerprints are stable and strip volatile line numbers', () => {
    const a = engine.toCandidate(failingTest);
    const b = engine.toCandidate({ ...failingTest, ruleOrTestId: 'adder adds:42' });
    const c = engine.toCandidate({ ...failingTest, ruleOrTestId: 'adder adds:99' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(b.fingerprint).toBe(c.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const other = engine.toCandidate({ ...failingTest, ruleOrTestId: 'adder subtracts' });
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });
});
