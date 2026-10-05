import type { OmnexxConfig, PriceConfig } from '../config/schema.js';
import { ConfigError } from '../errors.js';
import type { Usage } from './types.js';
import { isSwarmPool, SWARM_ENDPOINT, SWARM_POOLS, SWARM_PROVIDER } from './pools.js';

/**
 * USD per million tokens. Source: https://platform.claude.com/docs/en/about-claude/pricing and
 * https://platform.claude.com/docs/en/about-claude/models/overview, checked 2026-10-03.
 * Every entry can be overridden or extended with `[pricing.<alias>]` in config.
 * Cache-read rates are stored explicitly: Opus 5.5 uses 0.05× and Fable 5.1 0.025× of base input.
 */
export const PRICING_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-03)';

export const BUILTIN_PRICING: Record<string, PriceConfig> = {
  fable: {
    id: 'claude-fable-5-1',
    input: 10,
    output: 50,
    cache_write_5m: 12.5,
    cache_write_1h: 20,
    cache_read: 0.25,
    max_output_tokens: 128_000,
  },
  opus: {
    id: 'claude-opus-5-5',
    input: 4,
    output: 20,
    cache_write_5m: 5,
    cache_write_1h: 8,
    cache_read: 0.2,
    max_output_tokens: 128_000,
  },
  sonnet: {
    id: 'claude-sonnet-5-5',
    input: 2,
    output: 10,
    cache_write_5m: 2.5,
    cache_write_1h: 4,
    cache_read: 0.2,
    max_output_tokens: 128_000,
  },
  haiku: {
    id: 'claude-haiku-4-5-20251001',
    input: 1,
    output: 5,
    cache_write_5m: 1.25,
    cache_write_1h: 2,
    cache_read: 0.1,
    max_output_tokens: 64_000,
  },
};

export interface ResolvedModel {
  /** "anthropic" or the name of a configured endpoint. */
  provider: string;
  alias: string;
  id: string;
  price: PriceConfig;
}

const FREE: Omit<PriceConfig, 'id'> = {
  input: 0,
  output: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_read: 0,
};

/**
 * `anthropic:sonnet` or `openrouter:anthropic/claude-sonnet-5.5` → provider, concrete id and
 * prices. The part after the first colon is an alias from the pricing table, a model id in it,
 * or (on an endpoint marked `free`) any model id at $0.
 */
export function resolveModel(ref: string, config: OmnexxConfig): ResolvedModel {
  const cut = ref.indexOf(':');
  const provider = ref.slice(0, cut);
  const name = ref.slice(cut + 1);
  const endpoint = config.providers.endpoints[provider];
  if (provider !== 'anthropic' && !endpoint) {
    throw new ConfigError(
      `unknown provider "${provider}" in model "${ref}"`,
      `use anthropic, or add [providers.endpoints.${provider}] with base_url`,
    );
  }
  const table = { ...(provider === 'anthropic' ? BUILTIN_PRICING : {}), ...config.pricing };
  const byAlias = table[name];
  if (byAlias) return { provider, alias: name, id: byAlias.id, price: byAlias };
  const byId = Object.entries(table).find(([, p]) => p.id === name);
  if (byId) return { provider, alias: byId[0], id: name, price: byId[1] };
  if (
    provider === SWARM_PROVIDER &&
    endpoint?.base_url === SWARM_ENDPOINT.base_url &&
    !isSwarmPool(name)
  ) {
    throw new ConfigError(
      `unknown swarm pool "${name}" in model "${ref}"`,
      `use one of: ${Object.keys(SWARM_POOLS).join(', ')}`,
    );
  }
  if (endpoint?.free) return { provider, alias: name, id: name, price: { id: name, ...FREE } };
  throw new ConfigError(
    `no price for model "${name}" on ${provider}`,
    `add [pricing.<alias>] with id = "${name}" and per-MTok rates${endpoint ? ', or set free = true on the endpoint' : ''}`,
  );
}

/** A role's failover chain, in order. */
export function resolveChain(
  refs: string | readonly string[],
  config: OmnexxConfig,
): ResolvedModel[] {
  return (typeof refs === 'string' ? [refs] : refs).map((r) => resolveModel(r, config));
}

const M = 1_000_000;

export function costUsd(u: Usage, p: PriceConfig): number {
  return (
    (u.uncached * p.input +
      u.cacheWrite5m * p.cache_write_5m +
      u.cacheWrite1h * p.cache_write_1h +
      u.cacheRead * p.cache_read +
      u.output * p.output) /
    M
  );
}

/**
 * Worst case for one call: every input token billed at the most expensive input rate (a cache
 * write can cost more than base input) plus the full output cap.
 */
export function worstCaseUsd(inputTokens: number, maxOutput: number, p: PriceConfig): number {
  const inRate = Math.max(p.input, p.cache_write_5m, p.cache_write_1h);
  return (inputTokens * inRate + maxOutput * p.output) / M;
}
