import { ConfigError } from '../errors.js';
import type { OmnexxConfig, PriceConfig } from '../config/schema.js';
import { BUILTIN_PRICING, resolveModel, type ResolvedModel } from './pricing.js';

/** A resolved model whose price may be unknown (unpriced). */
export interface PricedModel extends Omit<ResolvedModel, 'price'> {
  price: PriceConfig | undefined;
}

export interface CostBreakdown {
  usd: number | undefined;
  unpriced: boolean;
}

/**
 * Lenient sibling of `resolveModel` (src/providers/pricing.ts): never throws for a
 * missing price. Unknown models resolve to their literal id with `price: undefined`
 * so tokens are still counted while cost stays unknown. Unknown providers still
 * throw: that is a config error, not a pricing gap. Run-deps and the loop can
 * switch to this resolver (see INTEGRATION note in docs/integration-notes.md).
 */
export function resolveModelLenient(ref: string, config: OmnexxConfig): PricedModel {
  if (!/^[a-z][a-z0-9_-]*:\S+$/.test(ref))
    throw new ConfigError(`bad model ref "${ref}"`, 'expected "<provider>:<alias-or-model-id>"');
  try {
    const m = resolveModel(ref, config);
    return m;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Unknown provider ("unknown provider ...") or unknown price ("no price for
    // model ..."): both resolve leniently. Only malformed refs still throw, and
    // resolveModel throws those as ConfigError too, so check the prefix.
    if (!err.message.startsWith('no price for model') && !err.message.startsWith('unknown provider')) throw err;
    const cut = ref.indexOf(':');
    const provider = ref.slice(0, cut);
    const name = ref.slice(cut + 1);
    const known = Object.entries({ ...BUILTIN_PRICING, ...config.pricing }).find(
      ([, p]) => p.id === name,
    );
    if (known) return { provider, alias: known[0], id: name, price: known[1] };
    return { provider, alias: name, id: name, price: undefined };
  }
}

/** A role's failover chain, in order, never throwing for missing prices. */
export function resolveChainLenient(
  refs: string | readonly string[],
  config: OmnexxConfig,
): PricedModel[] {
  return (typeof refs === 'string' ? [refs] : refs).map((r) => resolveModelLenient(r, config));
}

/** Cost in USD, or undefined when the model has no price. Tokens are always counted. */
export function costOf(
  usage: { uncached: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number },
  price: PriceConfig | undefined,
): CostBreakdown {
  if (!price) return { usd: undefined, unpriced: true };
  const M = 1_000_000;
  return {
    usd:
      (usage.uncached * price.input +
        usage.cacheWrite5m * price.cache_write_5m +
        usage.cacheWrite1h * price.cache_write_1h +
        usage.cacheRead * price.cache_read +
        usage.output * price.output) /
      M,
    unpriced: false,
  };
}

/** Display for a cost that may be unknown: "$1.2345" or "\u2013". */
export function formatCost(usd: number | undefined): string {
  return usd === undefined ? '\u2013' : `$${usd.toFixed(4)}`;
}

/** Worst-case cost for pre-flight, or undefined when unpriced (token caps apply). */
export function worstCaseOf(
  inputTokens: number,
  maxOutput: number,
  price: PriceConfig | undefined,
): number | undefined {
  if (!price) return undefined;
  const M = 1_000_000;
  const inRate = Math.max(price.input, price.cache_write_5m, price.cache_write_1h);
  return (inputTokens * inRate + maxOutput * price.output) / M;
}
