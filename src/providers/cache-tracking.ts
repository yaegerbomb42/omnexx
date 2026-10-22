import { cacheKeyFor, prefixHash, prefixQuality, profileFor } from './cache-pinning.js';
import type { CompletionRequest, CompletionResponse, Provider } from './types.js';

/**
 * Cache tracking for a provider.
 *
 * Every provider call goes through this wrapper, which records what the provider did with
 * its cache: how many prompt tokens it read from the cache, how many it processed fresh,
 * and how well the request's prefix was arranged for caching. The numbers go to the run's
 * event log, so `status --json` and the telemetry feed can show the cache hit rate without
 * asking the provider again.
 */

/** What one call did with its cache. */
export interface CacheEvent {
  /** The provider that answered. */
  provider: string;
  /** The model that answered. */
  model: string;
  /** Prompt tokens processed fresh. */
  uncached: number;
  /** Prompt tokens read from the cache. */
  cacheRead: number;
  /** Prompt tokens written into the cache. */
  cacheWrite: number;
  /** Output tokens. */
  output: number;
  /** The hit rate of this call (0 when there was no prompt). */
  hitRate: number;
  /** Estimated tokens of the stable prefix. */
  stableTokens: number;
  /** Share of the prompt that sat in the cacheable prefix. */
  stability: number;
  /** True when the provider can cache a prefix this big. */
  cacheable: boolean;
  /** The hash of the cacheable prefix. */
  prefixHash: string;
  /** How long the call took, in milliseconds. */
  ms: number;
}

export interface CacheTrackingOptions {
  /** Where the measurements go. */
  emit: (type: string, data: Record<string, unknown>) => void;
  /** Now, in milliseconds (injected so tests are deterministic). */
  now?: () => number;
  /** The token estimator used for the prefix measurement. */
  estimate?: (text: string) => number;
}

/**
 * Wraps a provider so every call reports what it did with its cache.
 *
 * The wrapper never changes the request: it only measures. The one thing it does change is
 * the cache key, and only when the caller did not set one: it derives a key that is stable
 * for the whole conversation (the run id plus the prefix hash), so every call of that
 * conversation lands on the same cache shard.
 */
export function withCacheTracking(inner: Provider, opts: CacheTrackingOptions): Provider {
  const now = opts.now ?? (() => Date.now());
  const estimate = opts.estimate ?? ((t: string) => Math.ceil(t.length / 3));
  return {
    name: inner.name,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const profile = profileFor(req.route ?? inner.name);
      const quality = prefixQuality(req, profile, estimate);
      const started = now();
      const res = await inner.complete(req);
      const cacheWrite = res.usage.cacheWrite5m + res.usage.cacheWrite1h;
      const input = res.usage.uncached + res.usage.cacheRead;
      const event: CacheEvent = {
        provider: req.route ?? inner.name,
        model: res.model,
        uncached: res.usage.uncached,
        cacheRead: res.usage.cacheRead,
        cacheWrite,
        output: res.usage.output,
        hitRate: input > 0 ? res.usage.cacheRead / input : 0,
        stableTokens: quality.stableTokens,
        stability: quality.stability,
        cacheable: quality.cacheable,
        prefixHash: quality.hash,
        ms: now() - started,
      };
      opts.emit('cache.tracked', { ...event });
      return res;
    },
  };
}

/**
 * The cache key for a conversation, derived from its stable prefix.
 *
 * The key must not change when the volatile part of the prompt changes, or the provider
 * routes the next turn to a different cache shard and the cache is missed. Only the stable
 * prefix takes part, so the key stays the same for the whole session.
 */
export function conversationCacheKey(
  runId: string,
  req: Pick<CompletionRequest, 'system' | 'tools'>,
): string {
  const hash = prefixHash(req);
  return cacheKeyFor(runId, hash);
}
