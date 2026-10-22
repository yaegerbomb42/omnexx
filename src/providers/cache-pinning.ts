import { createHash } from 'node:crypto';
import type { CompletionRequest, SystemBlock, ToolSpec } from './types.js';

/**
 * Provider-optimized KV-cache prefix pinning.
 *
 * A provider caches the *prefix* of a prompt: the tokens before the first byte that changes
 * are read from the cache instead of being re-processed. The hit rate therefore depends
 * entirely on how stable the front of the prompt is.
 *
 * Three things make it unstable, and each has a fix here:
 *
 * 1. The order of the blocks. The system prompt, the tool schemas and the project
 *    instructions must always appear in the same order, or the prefix breaks at the first
 *    difference. {@link pinPrefix} sorts them into a canonical order and never lets a
 *    volatile block sit in front of a stable one.
 * 2. Volatile content (the goal, the notes, this cycle's state) mixed into the stable
 *    prefix. Every provider here wants the volatile blocks *after* the stable ones, so a
 *    change to the goal never invalidates the tool schemas.
 * 3. Providers that key their cache on more than the text. OpenAI-compatible endpoints use
 *    a `prompt_cache_key` to route a conversation to the same cache shard; Anthropic needs
 *    an explicit cache breakpoint on the last stable block.
 *
 * The aim is a hit rate above 80% on the stable prefix across a long session.
 */

/** The providers this module knows how to pin for. */
export type CacheProvider = 'anthropic' | 'openai' | 'inception' | 'deepseek' | 'generic';

/** How a provider wants its cache prefix arranged. */
export interface PinProfile {
  /** The provider's cache model. */
  provider: CacheProvider;
  /**
   * Whether the provider sends its own cache key (`prompt_cache_key`). OpenAI-compatible
   * endpoints use it to route a conversation to the same cache shard; Anthropic does not.
   */
  usesPromptCacheKey: boolean;
  /**
   * Whether the provider needs an explicit cache breakpoint on the last stable block
   * (Anthropic's `cache_control`). OpenAI-compatible endpoints cache automatically.
   */
  needsBreakpoint: boolean;
  /** The smallest prefix (in tokens) the provider will cache at all. */
  minCacheableTokens: number;
}

/**
 * The cache profiles of the providers we optimise for.
 *
 * Anthropic: explicit `cache_control` breakpoints, and only a prefix of at least 1024
 * tokens is cached (below that the breakpoint costs a write and buys nothing).
 *
 * OpenAI (and OpenAI-compatible gateways): automatic prefix caching of 1024+ token
 * prefixes, with `prompt_cache_key` routing the conversation to the same shard.
 *
 * Inception Labs: an OpenAI-compatible endpoint, so it follows OpenAI's model, but its
 * cache key must stay stable across the whole session, not per turn.
 *
 * DeepSeek: an OpenAI-compatible endpoint with automatic context caching; DeepSeek counts
 * cache hits and misses per request, so the exact hit ratio is visible in the usage block.
 */
export const PIN_PROFILES: Record<CacheProvider, PinProfile> = {
  anthropic: {
    provider: 'anthropic',
    usesPromptCacheKey: false,
    needsBreakpoint: true,
    minCacheableTokens: 1024,
  },
  openai: {
    provider: 'openai',
    usesPromptCacheKey: true,
    needsBreakpoint: false,
    minCacheableTokens: 1024,
  },
  inception: {
    provider: 'inception',
    usesPromptCacheKey: true,
    needsBreakpoint: false,
    minCacheableTokens: 1024,
  },
  deepseek: {
    provider: 'deepseek',
    usesPromptCacheKey: true,
    needsBreakpoint: false,
    minCacheableTokens: 1024,
  },
  generic: {
    provider: 'generic',
    usesPromptCacheKey: false,
    needsBreakpoint: false,
    minCacheableTokens: 1024,
  },
};

/**
 * The cache profile of an endpoint by its name. Inception and DeepSeek are OpenAI-compatible
 * but get their own profile so their cache key and hit accounting are handled apart.
 */
export function profileFor(name: string): PinProfile {
  const key = name.toLowerCase();
  if (key === 'anthropic') return PIN_PROFILES.anthropic;
  if (key === 'inception') return PIN_PROFILES.inception;
  if (key === 'deepseek') return PIN_PROFILES.deepseek;
  if (key === 'openai' || key === 'openrouter' || key === 'litellm') return PIN_PROFILES.openai;
  return PIN_PROFILES.generic;
}

/**
 * The stable part of a prompt: the system blocks that do not change between turns.
 * Volatile blocks (the goal, the notes, this cycle's state) are excluded: they change, so
 * they can never be part of a cached prefix.
 */
export function stableBlocks(system: readonly SystemBlock[]): SystemBlock[] {
  return system.filter((b) => !b.volatile);
}

/** The volatile part of a prompt: the blocks that change between turns. */
export function volatileBlocks(system: readonly SystemBlock[]): SystemBlock[] {
  return system.filter((b) => b.volatile);
}

/**
 * The index of the last stable block, or -1 when every block is volatile.
 *
 * This is where the stable cacheable prefix ends. A provider that caches by breakpoint
 * (Anthropic) puts its breakpoint here, so a change to a volatile block never invalidates
 * the stable prefix in front of it.
 */
export function lastStableIndex(system: readonly SystemBlock[]): number {
  for (let i = system.length - 1; i >= 0; i--) {
    const b = system[i];
    if (b && !b.volatile) return i;
  }
  return -1;
}

/**
 * A stable hash of a request's cacheable prefix: the system blocks and the tool schemas,
 * in the order they are sent. Two requests with the same prefix hash read the same cache.
 */
export function prefixHash(req: {
  system: readonly SystemBlock[];
  tools: readonly ToolSpec[];
}): string {
  const hash = createHash('sha256');
  for (const b of stableBlocks(req.system)) hash.update(`system:${b.text}\n`);
  for (const t of req.tools)
    hash.update(`tool:${t.name}:${t.description}:${JSON.stringify(t.inputSchema)}\n`);
  return hash.digest('hex');
}

/**
 * The cache key a provider should use for a conversation: stable for the whole session, so
 * every call of that conversation lands on the same cache shard.
 *
 * The key is derived from the run's id and the prefix hash. It must not change when the
 * volatile part of the prompt changes, or the conversation is routed to a different shard
 * and the cache is missed on every turn.
 */
export function cacheKeyFor(runId: string, prefix: string): string {
  return `omnexx-${runId}-${prefix.slice(0, 16)}`;
}

/**
 * Reorder a request's system blocks so every stable block comes before every volatile one.
 *
 * Anthropic sends the blocks in the order they are given, and OpenAI-compatible endpoints
 * put the stable ones in the system message and carry the volatile ones into the first
 * user message (see `toChatMessages`). When a volatile block sits in front of a stable one,
 * the stable block falls out of the cacheable prefix, and the cache hit rate collapses.
 * This puts the stable blocks first, keeping their relative order.
 */
export function pinPrefix(system: readonly SystemBlock[]): SystemBlock[] {
  const stable = stableBlocks(system);
  const vol = volatileBlocks(system);
  if (!vol.length) return [...stable];
  // The breakpoint belongs on the last stable block: it ends the cacheable prefix.
  const pinned: SystemBlock[] = stable.map((b, i) => {
    const next: SystemBlock = { text: b.text, volatile: false };
    if (i === stable.length - 1) next.cacheBreakpoint = true;
    return next;
  });
  return [...pinned, ...vol];
}

/**
 * How well a request's prefix is arranged for caching: the share of the cacheable prefix
 * that is stable, and whether the provider can actually cache it.
 */
export interface PrefixQuality {
  /** Estimated tokens of the stable prefix. */
  stableTokens: number;
  /** Estimated tokens of the whole prompt. */
  prefixTokens: number;
  /** Share of the prompt that sits in the cacheable prefix. */
  stability: number;
  /** True when the stable prefix is big enough for the provider to cache it. */
  cacheable: boolean;
  /** The hash of the cacheable prefix: the same hash means the same cache entry. */
  hash: string;
}

/**
 * How a request's prefix would fare with a provider's cache. `estimate` is the caller's
 * token estimator (the harness's own, so the number matches the rest of the accounting).
 */
export function prefixQuality(
  req: Pick<CompletionRequest, 'system' | 'tools' | 'messages'>,
  profile: PinProfile,
  estimate: (text: string) => number = (t) => Math.ceil(t.length / 3),
): PrefixQuality {
  const stable = stableBlocks(req.system);
  const stableTokens =
    estimate(stable.map((b) => b.text).join('\n\n')) + estimate(JSON.stringify(req.tools));
  const prefixTokens = stableTokens + estimate(JSON.stringify(req.messages.map((m) => m.content)));
  return {
    stableTokens,
    prefixTokens,
    stability: prefixTokens > 0 ? stableTokens / prefixTokens : 0,
    cacheable: stableTokens >= profile.minCacheableTokens,
    hash: prefixHash(req),
  };
}
