import { describe, expect, it } from 'vitest';
import { BudgetGovernor } from '../../src/core/budgetGovernor.js';
import { ProviderCircuitBreaker } from '../../src/providers/circuit-breaker.js';
import { DeterministicRandom, FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('starts at the given time and now() reports it', () => {
    const clock = new FakeClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(new FakeClock().now()).toBe(1_700_000_000_000);
  });

  it('sleep advances virtual time instantly (no real waiting)', async () => {
    const clock = new FakeClock(0);
    const start = Date.now();
    await clock.sleep(86_400_000); // a whole day
    expect(Date.now() - start).toBeLessThan(100);
    expect(clock.now()).toBe(86_400_000);
    expect(clock.sleeps).toEqual([86_400_000]);
  });

  it('advance/set move time; advance rejects negative deltas', () => {
    const clock = new FakeClock(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
    expect(() => {
      clock.advance(-1);
    }).toThrow(/negative/);
  });

  it('sleep rejects when the signal is already aborted', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    controller.abort(new Error('boom'));
    await expect(clock.sleep(1000, controller.signal)).rejects.toThrow('boom');
    expect(clock.now()).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it('sleep resolves when the signal is not aborted', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    await expect(clock.sleep(250, controller.signal)).resolves.toBeUndefined();
    expect(clock.now()).toBe(250);
  });

  it('is injectable as a `now` source for the budget governor and provider breaker', () => {
    const clock = new FakeClock(1_000_000);
    const governor = new BudgetGovernor({
      storage: {
        load: () => 0,
        save: () => {
          /* no persistence in this test */
        },
      },
      priceCard: { m: { input: 0.01, output: 0.02 } },
      sessionCap: 10,
      now: clock.now.bind(clock),
    });
    expect(governor.check({ promptTokens: 10, outputTokens: 10, model: 'm' }).allowed).toBe(true);
    clock.advance(60_000);
    governor.persist();

    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 1,
      baseCooloffMs: 60_000,
      now: clock.now.bind(clock),
    });
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    clock.advance(60_000);
    expect(breaker.state).toBe('half-open');
  });
});

describe('DeterministicRandom', () => {
  it('same seed reproduces the same sequence; reset restarts it', () => {
    const a = new DeterministicRandom(42);
    const b = new DeterministicRandom(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
    a.reset();
    expect(Array.from({ length: 10 }, () => a.next())).toEqual(seqA);
  });

  it('different seeds diverge immediately', () => {
    expect(new DeterministicRandom(1).next()).not.toBe(new DeterministicRandom(2).next());
  });

  it('next() stays in [0, 1) and nextInt stays in range', () => {
    const rng = new DeterministicRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(rng.nextInt(5)).toBeGreaterThanOrEqual(0);
      expect(rng.nextInt(5)).toBeLessThan(5);
    }
    expect(() => rng.nextInt(0)).toThrow(/positive integer/);
  });

  it('pick returns a member; shuffle is a deterministic permutation', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(items).toContain(new DeterministicRandom(99).pick(items));
    expect(() => new DeterministicRandom(99).pick([])).toThrow(/empty/);
    const shuffled = new DeterministicRandom(99).shuffle(items);
    expect([...shuffled].sort()).toEqual([...items].sort());
    expect(new DeterministicRandom(99).shuffle(items)).toEqual(shuffled);
    expect(items).toEqual(['a', 'b', 'c', 'd']); // input untouched
  });

  it('nextBool honours p=0 and p=1', () => {
    const rng = new DeterministicRandom(3);
    expect(Array.from({ length: 5 }, () => rng.nextBool(0)).every((v) => !v)).toBe(true);
    expect(Array.from({ length: 5 }, () => rng.nextBool(1)).every((v) => v)).toBe(true);
  });
});
