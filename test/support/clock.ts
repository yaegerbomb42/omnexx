import type { Clock } from '../../src/core/clock.js';

/** A clock whose sleeps advance time instantly. `sleeps` records every requested delay. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
