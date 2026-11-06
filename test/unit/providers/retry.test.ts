import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../src/errors.js';
import { ProvidersUnavailable, withRetry } from '../../../src/providers/retry.js';
import { FakeClock } from '../../support/clock.js';

const retryable = () => new ProviderError('529 overloaded', { retryable: true, status: 529 });

describe('withRetry deadline clamping', () => {
  it('clamps sleeps so total never exceeds giveUpAfterMs', async () => {
    const clock = new FakeClock();
    const err = await withRetry(() => Promise.reject(retryable()), {
      clock,
      giveUpAfterMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvidersUnavailable);
    expect((err as ProvidersUnavailable).waitedMs).toBe(5_000);
    // Backoff steps [2_000, 4_000] clamped to remaining budget => [2_000, 3_000].
    expect(clock.sleeps).toEqual([2_000, 3_000]);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it('fails fast when retryAfterMs exceeds remaining deadline budget', async () => {
    const clock = new FakeClock();
    const err = new ProviderError('429 too many', {
      retryable: true,
      status: 429,
      retryAfterMs: 100_000,
    });
    const thrown = await withRetry(() => Promise.reject(err), {
      clock,
      giveUpAfterMs: 5_000,
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProvidersUnavailable);
    expect((thrown as ProvidersUnavailable).waitedMs).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it('ignores NaN retryAfterMs and falls back to normal backoff', async () => {
    const clock = new FakeClock();
    const err = new ProviderError('429 too many', {
      retryable: true,
      status: 429,
      retryAfterMs: NaN,
    });
    const thrown = await withRetry(() => Promise.reject(err), {
      clock,
      giveUpAfterMs: 5_000,
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProvidersUnavailable);
    expect((thrown as ProvidersUnavailable).waitedMs).toBe(5_000);
    expect(clock.sleeps).toEqual([2_000, 3_000]);
  });

  it('ignores negative retryAfterMs and falls back to normal backoff', async () => {
    const clock = new FakeClock();
    const err = new ProviderError('429 too many', {
      retryable: true,
      status: 429,
      retryAfterMs: -100,
    });
    const thrown = await withRetry(() => Promise.reject(err), {
      clock,
      giveUpAfterMs: 5_000,
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProvidersUnavailable);
    expect((thrown as ProvidersUnavailable).waitedMs).toBe(5_000);
    expect(clock.sleeps).toEqual([2_000, 3_000]);
  });
});
