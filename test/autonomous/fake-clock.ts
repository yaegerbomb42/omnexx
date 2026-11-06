/**
 * Deterministic time and randomness for the autonomous-daemon test suite.
 *
 * `FakeClock` implements the repo's `Clock` interface (`src/core/clock.ts`):
 * `sleep` advances virtual time instantly instead of waiting, so the soak
 * test can simulate ~30 days and the watchdog / lease tests can jump past
 * their thresholds in milliseconds.
 *
 * `DeterministicRandom` is a seeded mulberry32 PRNG: same seed, same
 * sequence, so crash-point selection and scripted flaky outcomes are
 * reproducible across runs.
 *
 * Injection status (verified against the tree on 2026-11-06):
 * - `AutonomousDaemon` accepts a `Clock` (`clock` option) — injectable.
 * - `TaskCircuitBreaker` / `WatchdogMonitor` accept `now: () => number` —
 *   pass `clock.now.bind(clock)`.
 * - `BudgetGovernor` / `TaskGovernor` / `ProviderCircuitBreaker` accept
 *   `now: () => number` — same pattern.
 * - `AutonomousStateStore` does NOT accept a clock: it calls `Date.now()`
 *   internally. Its time-dependent reads accept an explicit `nowMs`
 *   (`isTombstoned(fp, nowMs)`, `cooldownUntilForStrike(strike, nowMs)`),
 *   so tests drive those with `clock.now()` instead.
 */
import type { Clock } from '../../src/core/clock.js';

/** A clock whose sleeps advance time instantly. `sleeps` records every requested delay. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];

  constructor(private t = 1_700_000_000_000) {}

  now(): number {
    return this.t;
  }

  /** Jump to an absolute virtual time. */
  set(t: number): void {
    this.t = t;
  }

  /** Move virtual time forward by `ms` (must be non-negative). */
  advance(ms: number): void {
    if (ms < 0) throw new Error(`FakeClock.advance: negative ms (${ms})`);
    this.t += ms;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const reason = signal.reason as unknown;
      return Promise.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

/** Seeded PRNG (mulberry32): same seed always yields the same sequence. */
export class DeterministicRandom {
  private state: number;

  constructor(private readonly seed = 1) {
    this.state = seed >>> 0;
  }

  getSeed(): number {
    return this.seed;
  }

  /** Next value in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`DeterministicRandom.nextInt: n must be a positive integer (got ${n})`);
    }
    return Math.floor(this.next() * n);
  }

  /** True with probability `p` (default 0.5). */
  nextBool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Deterministic pick from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('DeterministicRandom.pick: empty array');
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('DeterministicRandom.pick: unreachable');
    return item;
  }

  /** Fisher-Yates shuffle; returns a new array, input untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = out[i];
      out[i] = out[j] as T;
      out[j] = tmp as T;
    }
    return out;
  }

  /** Restart the sequence (same seed by default). */
  reset(seed: number = this.seed): void {
    this.state = seed >>> 0;
  }
}
