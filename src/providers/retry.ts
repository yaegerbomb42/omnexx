import type { Clock } from '../core/clock.js';
import { ProviderError } from '../errors.js';

export interface RetryHooks {
  clock: Clock;
  /** Called before each wait. Return true to give up (e.g. a stop request). */
  shouldStop?: () => Promise<boolean>;
  onRetry?: (info: { attempt: number; delayMs: number; error: string; outageMs: number }) => void;
  /** Fired once when continuous failure passes `outageNotifyMs`. */
  onOutage?: (outageMs: number) => void;
  onRecovered?: (outageMs: number, attempts: number) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  outageNotifyMs?: number;
  /** Stop waiting after this long without a working provider (unset: wait for ever). */
  giveUpAfterMs?: number;
  signal?: AbortSignal;
}

/** Every provider kept failing for longer than `giveUpAfterMs`: quotas gone, keys bad, or down. */
export class ProvidersUnavailable extends Error {
  constructor(
    readonly lastError: string,
    readonly waitedMs: number,
  ) {
    super(lastError);
  }
}

export class StopRequested extends Error {
  constructor() {
    super('stop requested while waiting for the provider');
  }
}

/**
 * Retry retryable provider errors with exponential backoff capped at 30 minutes: an API outage
 * pauses the run instead of failing it (plan §3.9), until `giveUpAfterMs` if set. Non-retryable
 * errors throw at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, hooks: RetryHooks): Promise<T> {
  const base = hooks.baseDelayMs ?? 2_000;
  const max = hooks.maxDelayMs ?? 30 * 60_000;
  const notifyAfter = hooks.outageNotifyMs ?? 15 * 60_000;
  let attempt = 0;
  let firstFailure: number | undefined;
  let notified = false;
  for (;;) {
    try {
      const out = await fn();
      if (firstFailure !== undefined)
        hooks.onRecovered?.(hooks.clock.now() - firstFailure, attempt);
      return out;
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || hooks.signal?.aborted) throw err;
      attempt++;
      firstFailure ??= hooks.clock.now();
      const outageMs = hooks.clock.now() - firstFailure;
      if (!notified && outageMs >= notifyAfter) {
        notified = true;
        hooks.onOutage?.(outageMs);
      }
      if (hooks.giveUpAfterMs !== undefined && outageMs >= hooks.giveUpAfterMs)
        throw new ProvidersUnavailable(err.message, outageMs);
      const backoff = Math.min(max, base * 2 ** Math.min(attempt - 1, 20));
      // Retry-After is a floor: never call back sooner than the server asked.
      const delayMs = Math.min(
        max,
        err.retryAfterMs !== undefined ? Math.max(backoff, err.retryAfterMs) : backoff,
      );
      hooks.onRetry?.({ attempt, delayMs, error: err.message, outageMs });
      if (await hooks.shouldStop?.()) throw new StopRequested();
      await hooks.clock.sleep(delayMs, hooks.signal);
    }
  }
}
