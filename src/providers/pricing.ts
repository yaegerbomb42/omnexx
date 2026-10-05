import type { OmnexxConfig, PriceConfig } from '../config/schema.js';
import { ConfigError, NotImplementedError } from '../errors.js';
import type { Usage } from './types.js';

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
  provider: 'anthropic';
  alias: string;
  id: string;
  price: PriceConfig;
}

/** `anthropic:sonnet` → concrete id + prices. A raw model id works if it is in the table (by id). */
export function resolveModel(ref: string, config: OmnexxConfig): ResolvedModel {
  const [provider, name = ''] = ref.split(':', 2);
  if (provider !== 'anthropic') {
    throw new NotImplementedError(
      `model provider "${provider ?? ''}" (only "anthropic" is supported)`,
      'a later milestone',
    );
  }
  const table = { ...BUILTIN_PRICING, ...config.pricing };
  const byAlias = table[name];
  if (byAlias) return { provider, alias: name, id: byAlias.id, price: byAlias };
  const byId = Object.entries(table).find(([, p]) => p.id === name);
  if (byId) return { provider, alias: byId[0], id: name, price: byId[1] };
  throw new ConfigError(
    `no price for model "${name}"`,
    `add [pricing.${name.replace(/[^A-Za-z0-9_-]/g, '_')}] with id and per-MTok rates, or use one of: ${Object.keys(table).join(', ')}`,
  );
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
