import type { OmnexxConfig } from '../config/schema.js';
import { resolveChain, type ResolvedModel } from '../providers/pricing.js';

/** The provider of a `provider:model` ref. */
export function providerOf(ref: string): string {
  return ref.slice(0, ref.indexOf(':'));
}

/**
 * Whether a provider can take a call at all: anthropic is built in, anything else needs a
 * [providers.endpoints.<name>] entry. Key presence is checked where keys live (run-deps,
 * which skips a key-less pool provider instead of failing); here an endpoint without a
 * key still counts as configured.
 */
export function isProviderConfigured(provider: string, config: OmnexxConfig): boolean {
  return provider === 'anthropic' || provider in config.providers.endpoints;
}

export interface PoolFilter {
  /** The refs to use, in order. */
  refs: string[];
  /** Refs dropped: on a provider outside the list, or one with no endpoint configured. */
  skipped: string[];
  /** True when the filter left nothing and the unfiltered list was kept instead. */
  fellBack: boolean;
}

/**
 * Restrict a model list to `pool.providers`, the ordered provider allow-list (empty means
 * every provider, the current behaviour). Survivors come in the list's order — the tiebreak
 * the role chain's own order doesn't settle — with models keeping their order inside a
 * provider; the routing strategy then applies on top (random reshuffles per call,
 * least-busy orders by load, fallback/priority keep this order). A provider with no
 * endpoint configured is skipped, never fatal: a stale name must not stop a run. When
 * nothing survives, the unfiltered list is kept and `fellBack` is set, so a stale provider
 * list degrades to the old behaviour with a warning, not a hard failure.
 */
export function applyProviderPool(refs: readonly string[], config: OmnexxConfig): PoolFilter {
  const allowed = config.pool.providers;
  if (allowed.length === 0) return { refs: [...refs], skipped: [], fellBack: false };
  const rank = new Map(allowed.map((p, i) => [p, i]));
  const skipped: string[] = [];
  const kept = refs.filter((ref) => {
    const p = providerOf(ref);
    if (!rank.has(p) || !isProviderConfigured(p, config)) {
      skipped.push(ref);
      return false;
    }
    return true;
  });
  if (kept.length === 0 && refs.length > 0) return { refs: [...refs], skipped, fellBack: true };
  const ordered = [...kept].sort(
    (a, b) => (rank.get(providerOf(a)) ?? 0) - (rank.get(providerOf(b)) ?? 0),
  );
  return { refs: ordered, skipped, fellBack: false };
}

/** A role chain resolved through the provider pool: filtered, then priced. */
export function resolvePoolChain(
  refs: string | readonly string[],
  config: OmnexxConfig,
): ResolvedModel[] {
  const list = typeof refs === 'string' ? [refs] : refs;
  return resolveChain(applyProviderPool(list, config).refs, config);
}
