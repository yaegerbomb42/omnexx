/**
 * Circuit-breaker + watchdog tests (`src/autonomous/circuit-breaker.ts`).
 *
 * `TaskCircuitBreaker` trips a task into quarantine on: 3 consecutive
 * identical tool errors (or 4 total), a repeated tree hash (A→B→A), 6
 * consecutive read-only turns (nudge on 5), the 25-turn ceiling, or the
 * wall-clock lease. `WatchdogMonitor` is the independent wall-clock timer
 * that SIGKILLs a stalled child process group.
 *
 * Note: the tombstone ladder is defined once in the SQLite store
 * (`TOMBSTONE_COOLDOWNS_MS`: 1h → 6h → 24h → 7d → permanent at strike 5)
 * and mirrored by `tombstoneCooldownMs` here. The daemon persists
 * tombstones via `store.tombstone()`, so the store's ladder governs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashToolError,
  makeTombstone,
  TaskCircuitBreaker,
  tombstoneCooldownMs,
  WatchdogMonitor,
  type TurnOutcome,
} from '../../src/autonomous/circuit-breaker.js';
import { FakeClock } from './fake-clock.js';

const HOUR = 60 * 60 * 1000;
const IDENTICAL_STDERR = [
  'Error: boom — synthetic failure (identical every run)',
  '    at fail (scripts/fail.mjs:3:11)',
  '    at main (scripts/fail.mjs:7:1)',
].join('\n');

const okTurn = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  isReadOnly: false,
  ...over,
});

describe('TaskCircuitBreaker — identical tool errors', () => {
  let clock: FakeClock;
  let breaker: TaskCircuitBreaker;

  beforeEach(() => {
    clock = new FakeClock(1_700_000_000_000);
    breaker = new TaskCircuitBreaker({ now: () => clock.now(), maxWallClockSec: 3600 });
    breaker.beginTask();
  });

  afterEach(() => {
    breaker.endTask();
  });

  it('trips on the 3rd consecutive identical error', () => {
    const failing = (): TurnOutcome => ({
      isReadOnly: false,
      toolName: 'bash',
      errorContent: IDENTICAL_STDERR,
    });
    expect(breaker.evaluateTurn(failing()).trip).toBeUndefined();
    expect(breaker.evaluateTurn(failing()).trip).toBeUndefined();
    const third = breaker.evaluateTurn(failing());
    expect(third.trip?.reason).toBe('identical_tool_errors');
    expect(third.trip?.turn).toBe(3);
    expect(third.trip?.errorHash).toMatch(/^[0-9a-f]{16}$/);
    expect(breaker.isTripped).toBe(true);
    expect(breaker.signal.aborted).toBe(true);
  });

  it('different errors do not trip; a success resets the consecutive streak', () => {
    const fail = (msg: string): TurnOutcome => ({
      isReadOnly: false,
      toolName: 'bash',
      errorContent: msg,
    });
    expect(breaker.evaluateTurn(fail('error one')).trip).toBeUndefined();
    expect(breaker.evaluateTurn(fail('error two')).trip).toBeUndefined();
    expect(breaker.evaluateTurn(fail('error one')).trip).toBeUndefined();
    expect(breaker.evaluateTurn(okTurn()).trip).toBeUndefined(); // success resets streak
    expect(breaker.evaluateTurn(fail('error one')).trip).toBeUndefined(); // 3rd total
    // 4th total identical error trips even though the streak was broken.
    const fourth = breaker.evaluateTurn(fail('error one'));
    expect(fourth.trip?.reason).toBe('identical_tool_errors');
  });

  it('line numbers in stderr do not break identity (normalised before hashing)', () => {
    expect(hashToolError('bash', 'Error at foo.ts:12\nboom')).toBe(
      hashToolError('bash', 'Error at foo.ts:99\nboom'),
    );
    expect(hashToolError('bash', 'Error at foo.ts:12\nboom')).not.toBe(
      hashToolError('bash', 'Error at foo.ts:12\nbam'),
    );
    expect(hashToolError('bash', 'same error')).not.toBe(hashToolError('edit_file', 'same error'));
    // Only the first 3 stderr lines are hashed.
    const three = 'l1\nl2\nl3\nDIFFERENT TAIL';
    const threeOther = 'l1\nl2\nl3\nOTHER TAIL';
    expect(hashToolError('bash', three)).toBe(hashToolError('bash', threeOther));
  });

  it('onTrip fires exactly once and the first trip sticks', () => {
    const trips: string[] = [];
    const b = new TaskCircuitBreaker({
      now: () => clock.now(),
      maxWallClockSec: 3600,
      onTrip: (t) => {
        trips.push(t.reason);
      },
    });
    b.beginTask();
    try {
      const failing = (): TurnOutcome => ({
        isReadOnly: false,
        toolName: 'bash',
        errorContent: IDENTICAL_STDERR,
      });
      b.evaluateTurn(failing());
      b.evaluateTurn(failing());
      b.evaluateTurn(failing());
      expect(trips).toEqual(['identical_tool_errors']);
      b.evaluateTurn(failing());
      expect(trips).toEqual(['identical_tool_errors']);
      expect(b.trip?.reason).toBe('identical_tool_errors');
    } finally {
      b.endTask();
    }
  });

  it('beginTask resets the breaker after a trip', () => {
    const failing = (): TurnOutcome => ({
      isReadOnly: false,
      toolName: 'bash',
      errorContent: IDENTICAL_STDERR,
    });
    breaker.evaluateTurn(failing());
    breaker.evaluateTurn(failing());
    breaker.evaluateTurn(failing());
    expect(breaker.isTripped).toBe(true);
    breaker.beginTask();
    expect(breaker.isTripped).toBe(false);
    expect(breaker.currentTurn).toBe(0);
    expect(breaker.evaluateTurn(failing()).trip).toBeUndefined();
  });
});

describe('TaskCircuitBreaker — tree cycles, stalls, ceilings, leases', () => {
  let clock: FakeClock;
  let breaker: TaskCircuitBreaker;

  beforeEach(() => {
    clock = new FakeClock(1_700_000_000_000);
    breaker = new TaskCircuitBreaker({ now: () => clock.now(), maxWallClockSec: 3600 });
    breaker.beginTask();
  });

  afterEach(() => {
    breaker.endTask();
  });

  it('tree-hash cycle trips on A→B→A', () => {
    expect(breaker.evaluateTurn(okTurn({ treeHash: 'aaa' })).trip).toBeUndefined();
    expect(breaker.evaluateTurn(okTurn({ treeHash: 'bbb' })).trip).toBeUndefined();
    const third = breaker.evaluateTurn(okTurn({ treeHash: 'aaa' }));
    expect(third.trip?.reason).toBe('tree_cycle');
    expect(third.trip?.detail).toMatch(/aaa/);
  });

  it('tree hashes outside the 6-entry window do not trip', () => {
    for (const h of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(breaker.recordTreeHash(h)).toBeUndefined();
    }
    // '1' was evicted from the window by '7', so re-adding it does not trip;
    // '7' is still inside the window and trips.
    expect(breaker.recordTreeHash('1')).toBeUndefined();
    expect(breaker.recordTreeHash('7')?.reason).toBe('tree_cycle');
  });

  it('read-only stall nudges on turn 5 and trips on turn 6', () => {
    const readOnly: TurnOutcome = { isReadOnly: true };
    for (let i = 1; i <= 4; i++) {
      const ev = breaker.evaluateTurn(readOnly);
      expect(ev.trip).toBeUndefined();
      expect(ev.nudge).toBeUndefined();
    }
    const fifth = breaker.evaluateTurn(readOnly);
    expect(fifth.trip).toBeUndefined();
    expect(fifth.nudge).toMatch(/5 consecutive read-only turns/);
    const sixth = breaker.evaluateTurn(readOnly);
    expect(sixth.trip?.reason).toBe('read_stall');
    expect(sixth.trip?.turn).toBe(6);
  });

  it('a mutating turn resets the read-only stall counter', () => {
    const readOnly: TurnOutcome = { isReadOnly: true };
    for (let i = 0; i < 4; i++) breaker.evaluateTurn(readOnly);
    expect(breaker.evaluateTurn(okTurn()).nudge).toBeUndefined(); // mutation resets
    for (let i = 0; i < 4; i++) {
      expect(breaker.evaluateTurn(readOnly).nudge).toBeUndefined();
    }
    expect(breaker.evaluateTurn(readOnly).nudge).toMatch(/5 consecutive read-only turns/);
    expect(breaker.isTripped).toBe(false);
  });

  it('turn ceiling trips at 25; completing exactly on turn 25 ships instead', () => {
    for (let i = 1; i < 25; i++) {
      expect(breaker.evaluateTurn(okTurn()).trip).toBeUndefined();
    }
    expect(breaker.currentTurn).toBe(24);
    expect(breaker.evaluateTurn(okTurn()).trip?.reason).toBe('turn_ceiling');

    const finisher = new TaskCircuitBreaker({ now: () => clock.now(), maxWallClockSec: 3600 });
    finisher.beginTask();
    try {
      for (let i = 1; i < 25; i++) finisher.evaluateTurn(okTurn());
      const done = finisher.evaluateTurn(okTurn({ done: true }));
      expect(done.trip).toBeUndefined();
      expect(finisher.currentTurn).toBe(25);
    } finally {
      finisher.endTask();
    }
  });

  it('wall-clock lease trips via FakeClock once the lease elapses', () => {
    const leased = new TaskCircuitBreaker({
      now: () => clock.now(),
      maxWallClockSec: 60,
    });
    leased.beginTask();
    try {
      expect(leased.checkWallClock()).toBeUndefined();
      clock.advance(59_000);
      expect(leased.checkWallClock()).toBeUndefined();
      clock.advance(2000);
      expect(leased.checkWallClock()?.reason).toBe('wall_clock_lease');
      // evaluateTurn checks the lease first, before any other rule.
      expect(leased.evaluateTurn(okTurn()).trip?.reason).toBe('wall_clock_lease');
    } finally {
      leased.endTask();
    }
  });

  it('checkWallClock is a no-op before beginTask', () => {
    const fresh = new TaskCircuitBreaker({ now: () => clock.now() });
    expect(fresh.checkWallClock()).toBeUndefined();
  });
});

describe('circuit-breaker tombstones', () => {
  it('cooldown ladder is 1h → 6h → 24h → 7d → permanent', () => {
    expect(tombstoneCooldownMs(0)).toBe(1 * HOUR);
    expect(tombstoneCooldownMs(1)).toBe(1 * HOUR);
    expect(tombstoneCooldownMs(2)).toBe(6 * HOUR);
    expect(tombstoneCooldownMs(3)).toBe(24 * HOUR);
    expect(tombstoneCooldownMs(4)).toBe(7 * 24 * HOUR);
    expect(tombstoneCooldownMs(5)).toBe(-1);
    expect(tombstoneCooldownMs(99)).toBe(-1);
  });

  it('makeTombstone sets the lift time, or none when permanent', () => {
    const now = 1_700_000_000_000;
    const first = makeTombstone('task-1', 1, 'tree_cycle', 'blob1', now);
    expect(first.cooldownMs).toBe(1 * HOUR);
    expect(first.tombstonedUntilMs).toBe(now + 1 * HOUR);
    expect(first.targetBlobSha).toBe('blob1');
    const fifth = makeTombstone('task-1', 5, 'tree_cycle', 'blob1', now);
    expect(fifth.cooldownMs).toBe(-1);
    expect(fifth.tombstonedUntilMs).toBeUndefined();
  });
});

describe('WatchdogMonitor', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(1_700_000_000_000);
  });

  it('fires onStall (and SIGKILLs the registered pgid) after stallMs of silence', async () => {
    const stalls: { taskId: string | undefined; stalledForMs: number }[] = [];
    const killed: number[] = [];
    const watchdog = new WatchdogMonitor({
      stallMs: 300_000,
      now: () => clock.now(),
      killProcessGroup: (pgid) => {
        killed.push(pgid);
      },
      onStall: (info) => {
        stalls.push(info);
      },
    });
    watchdog.noteProgress('task-9');
    watchdog.registerChildProcessGroup(4242, 'task-9');

    expect(await watchdog.checkStall(clock.now() + 299_999)).toBe(false);
    expect(stalls).toEqual([]);
    clock.advance(300_000);
    expect(await watchdog.checkStall(clock.now())).toBe(true);
    expect(stalls).toEqual([{ taskId: 'task-9', stalledForMs: 300_000 }]);
    expect(killed).toEqual([4242]);

    // The stall resets the progress clock: silence must build up again.
    expect(await watchdog.checkStall(clock.now())).toBe(false);
    clock.advance(300_000);
    expect(await watchdog.checkStall(clock.now())).toBe(true);
    expect(stalls).toHaveLength(2);
    watchdog.stop();
  });

  it('noteProgress resets the stall clock; no pgid means no kill', async () => {
    let stalls = 0;
    const killed: number[] = [];
    const watchdog = new WatchdogMonitor({
      stallMs: 60_000,
      now: () => clock.now(),
      killProcessGroup: (pgid) => {
        killed.push(pgid);
      },
      onStall: () => {
        stalls++;
      },
    });
    watchdog.noteProgress('task-1');
    clock.advance(59_000);
    watchdog.noteProgress('task-1');
    clock.advance(59_000);
    expect(await watchdog.checkStall(clock.now())).toBe(false);
    expect(stalls).toBe(0);
    clock.advance(2000);
    expect(await watchdog.checkStall(clock.now())).toBe(true);
    expect(killed).toEqual([]);
    expect(watchdog.stalledForMs).toBe(0);
    watchdog.stop();
  });

  it('start/stop are safe to call repeatedly', () => {
    const watchdog = new WatchdogMonitor({
      intervalMs: 60_000,
      stallMs: 60_000,
      now: () => clock.now(),
      onStall: () => undefined,
    });
    watchdog.start();
    watchdog.start();
    watchdog.stop();
    watchdog.stop();
  });
});
