/**
 * Cache hit tracking.
 *
 * The provider tells us how many prompt tokens it read from its cache and how many it
 * processed fresh. This folds those numbers into the run's totals and answers the two
 * questions the harness cares about: what share of the prompt was cached (the hit rate),
 * and what the cache saved (the tokens and dollars it did not have to pay for).
 */

import type { OmnexxEvent } from '../core/events.js';

/** The cache numbers of one provider call. */
export interface CacheSample {
  /** Prompt tokens the provider processed fresh. */
  uncached: number;
  /** Prompt tokens the provider read from its cache. */
  cacheRead: number;
  /** Prompt tokens written into the cache (billed at the write rate). */
  cacheWrite: number;
  /** Output tokens. */
  output: number;
  /** The provider that answered. */
  provider?: string;
  /** The model that answered. */
  model?: string;
}

/** The cache totals of a run. */
export interface CacheMetrics {
  /** Prompt tokens processed fresh across the run. */
  uncached: number;
  /** Prompt tokens read from the cache across the run. */
  cacheRead: number;
  /** Prompt tokens written into the cache across the run. */
  cacheWrite: number;
  /** Output tokens across the run. */
  output: number;
  /** How many provider calls reported usage. */
  calls: number;
  /** How many of those calls hit the cache at all. */
  hits: number;
  /** How many of those calls missed the cache entirely. */
  misses: number;
  /** Per-provider hit counts, for the endpoints we optimise for. */
  byProvider: Record<string, { hits: number; misses: number; cacheRead: number; uncached: number }>;
}

export function emptyCacheMetrics(): CacheMetrics {
  return {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    calls: 0,
    hits: 0,
    misses: 0,
    byProvider: {},
  };
}

/**
 * The hit rate of a sample: the share of the prompt that was read from the cache. A call
 * with no prompt tokens at all has no rate (undefined), not zero.
 */
export function sampleHitRate(s: CacheSample): number | undefined {
  const total = s.uncached + s.cacheRead;
  if (total <= 0) return undefined;
  return s.cacheRead / total;
}

/** Whether a call hit the cache at all (it read a single cached token). */
export function sampleHit(s: CacheSample): boolean {
  return s.cacheRead > 0;
}

/** Folds one provider call into the totals. Mutates and returns `m`. */
export function foldSample(m: CacheMetrics, s: CacheSample): CacheMetrics {
  m.uncached += s.uncached;
  m.cacheRead += s.cacheRead;
  m.cacheWrite += s.cacheWrite;
  m.output += s.output;
  m.calls++;
  const hit = sampleHit(s);
  if (hit) m.hits++;
  else m.misses++;
  const provider = s.provider ?? 'unknown';
  const bucket = (m.byProvider[provider] ??= { hits: 0, misses: 0, cacheRead: 0, uncached: 0 });
  bucket.cacheRead += s.cacheRead;
  bucket.uncached += s.uncached;
  if (hit) bucket.hits++;
  else bucket.misses++;
  return m;
}

/** The hit rate of the run: the share of all prompt tokens that came from the cache. */
export function cacheHitRate(m: CacheMetrics): number {
  const total = m.uncached + m.cacheRead;
  return total > 0 ? m.cacheRead / total : 0;
}

/**
 * The share of calls that hit the cache. A run of many calls wants this above 80%: it is
 * the number that says whether the prefix pinning is working.
 */
export function callHitRate(m: CacheMetrics): number {
  return m.calls > 0 ? m.hits / m.calls : 0;
}

/**
 * The tokens the cache saved: the prompt tokens that would have been processed fresh and
 * were read from the cache instead.
 */
export function savedTokens(m: CacheMetrics): number {
  return m.cacheRead;
}

/**
 * What the cache saved in dollars. A cache read costs about a tenth of fresh input on
 * every major provider, so the saving is 90% of the cache-read price.
 */
export function savedUsd(m: CacheMetrics, cacheReadPricePerMillion: number): number {
  return (m.cacheRead * cacheReadPricePerMillion * 0.9) / 1_000_000;
}

/** Folds a `turn` event into the cache totals. */
export function foldTurn(m: CacheMetrics, e: OmnexxEvent): CacheMetrics {
  const t = (e.tokens ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return foldSample(m, {
    uncached: num(t.uncached),
    cacheRead: num(t.cacheRead),
    cacheWrite: num(t.cacheWrite),
    output: num(t.output),
    ...(typeof e.provider === 'string' ? { provider: e.provider } : {}),
    ...(typeof e.model === 'string' ? { model: e.model } : {}),
  });
}

/**
 * The cache totals of a run, folded from its events. The `turn` events carry the provider's
 * own usage numbers, so the numbers here are what the provider billed, not an estimate.
 */
export function collectCacheMetrics(events: readonly OmnexxEvent[]): CacheMetrics {
  const m = emptyCacheMetrics();
  for (const e of events) if (e.type === 'turn') foldTurn(m, e);
  return m;
}
