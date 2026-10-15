import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/core/clock.js';
import type { GateResult } from '../../../src/verify/gates.js';
import { SpeculativeChecks } from '../../../src/verify/speculative.js';

/** Virtual time: sleeps wait until `advance` moves the clock past them. */
class VirtualClock implements Clock {
  t = 0;
  private timers: { at: number; resolve: () => void }[] = [];
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((resolve, reject) => {
      const timer = { at: this.t + ms, resolve };
      this.timers.push(timer);
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((x) => x !== timer);
        reject(new Error('aborted'));
      });
    });
  }
  /** Move time forward, firing due timers in order and letting their continuations run. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.resolve();
    }
    this.t = end;
    await flush();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const gate = (name: string): GateResult => ({
  name,
  level: 'ratchet',
  exitCode: 0,
  timedOut: false,
  durationMs: 0,
  failures: [],
  structured: true,
  logFile: `${name}.log`,
});

/** A fake gate runner taking `gateMs` of virtual time, over a mutable fake tree. */
function setup(gateMs: number) {
  const clock = new VirtualClock();
  const tree = { hash: 't0' };
  const events: string[] = [];
  const runs: { started: number; aborted: boolean }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const spec = new SpeculativeChecks({
    clock,
    debounceMs: 1_500,
    treeHash: () => Promise.resolve(tree.hash),
    run: async (signal) => {
      const r = { started: clock.now(), aborted: false };
      runs.push(r);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        await clock.sleep(gateMs, signal);
        return [gate('typecheck'), gate('test')];
      } catch (err) {
        r.aborted = true;
        throw err;
      } finally {
        inFlight--;
      }
    },
    emit: (type) => events.push(type),
  });
  return { clock, tree, events, runs, spec, maxInFlight: () => maxInFlight };
}

describe('SpeculativeChecks', () => {
  it('saves the whole gate time when the model talks longer than the gates take', async () => {
    // Arrange: an edit at t=0, gates take 15 s, the model keeps talking for 20 s.
    const { clock, spec, tree } = setup(15_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(20_000);

    // Act: the verify step arrives at t=20 s.
    const verifyAt = clock.now();
    const hit = await spec.take('t1');

    // Assert: the result is there already; without it the check would end at t=35 s.
    expect(hit?.results.map((r) => r.name)).toEqual(['typecheck', 'test']);
    expect(clock.now() - verifyAt).toBe(0);
    expect(hit && hit.finishedAt - hit.startedAt).toBe(15_000);
  });

  it('waits only for the rest of a run already going when the verify step arrives early', async () => {
    const { clock, spec, tree } = setup(15_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(6_500); // the run started at 1.5 s, 5 s in
    const verifyAt = clock.now();
    const pending = spec.take('t1');
    await clock.advance(10_000);
    const hit = await pending;
    expect(hit).toBeDefined();
    // 10 s of waiting instead of 15 s of running: 5 s saved on this pass.
    expect((hit?.finishedAt ?? 0) - verifyAt).toBe(10_000);
  });

  it('debounces: further edits cancel the pending run, one run at a time', async () => {
    const { clock, spec, tree, runs, maxInFlight } = setup(15_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(1_000);
    tree.hash = 't2';
    spec.touch(); // within the debounce: the first never starts
    await clock.advance(5_000); // second run started at 2.5 s
    tree.hash = 't3';
    spec.touch(); // mid-run: cancelled
    await clock.advance(20_000);
    expect(runs.map((r) => [r.started, r.aborted])).toEqual([
      [2_500, true],
      [7_500, false],
    ]);
    expect(maxInFlight()).toBe(1);
    expect(await spec.take('t2')).toBeUndefined();
    expect(await spec.take('t3')).toBeDefined();
  });

  it('never reuses a result for another tree', async () => {
    const { clock, spec, tree, events } = setup(1_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(5_000);
    expect(await spec.take('t-other')).toBeUndefined();
    expect(events).toContain('loop.speculative_miss');
  });

  it('drops a run whose tree changed underneath it without an edit', async () => {
    const { clock, spec, tree } = setup(10_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(5_000);
    tree.hash = 't2'; // a command changed files: no touch
    await clock.advance(10_000);
    expect(await spec.take('t1')).toBeUndefined();
    expect(await spec.take('t2')).toBeUndefined();
  });

  it('cancels a run still in its debounce when the verify step arrives', async () => {
    const { clock, spec, tree, runs } = setup(10_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(500);
    expect(await spec.take('t1')).toBeUndefined();
    await clock.advance(5_000);
    expect(runs).toHaveLength(0);
  });

  it('stop() kills a running attempt and ignores later edits', async () => {
    const { clock, spec, tree, runs } = setup(10_000);
    tree.hash = 't1';
    spec.touch();
    await clock.advance(2_000);
    await spec.stop();
    spec.touch();
    await clock.advance(30_000);
    expect(runs).toEqual([{ started: 1_500, aborted: true }]);
  });

  it('reports a failing run instead of swallowing it', async () => {
    const clock = new VirtualClock();
    const events: string[] = [];
    const spec = new SpeculativeChecks({
      clock,
      debounceMs: 10,
      treeHash: () => Promise.resolve('t'),
      run: () => Promise.reject(new Error('boom')),
      emit: (type) => events.push(type),
    });
    spec.touch();
    await clock.advance(100);
    expect(events).toContain('loop.speculative_failed');
    expect(await spec.take('t')).toBeUndefined();
  });
});
