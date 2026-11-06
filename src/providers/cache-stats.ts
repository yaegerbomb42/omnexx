/**
 * Prompt-cache economics for status views and benches. Prices are multiples of the uncached
 * input price (Anthropic: read 0.1x, 5m write 1.25x); output is assumed ~5x input when only a
 * total dollar figure is known.
 */
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;
const OUTPUT_MULT = 5;

export interface CacheTotals {
  /** All prompt tokens (uncached + cache reads + cache writes). */
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  output?: number;
  usd?: number;
}

export interface CacheSummary {
  hitPercent: number;
  /** Uncached-input-equivalent tokens saved vs sending everything uncached. */
  savedTokens: number;
  /** Estimated dollars saved (0 when no dollar total is known). */
  savedUsd: number;
}

export function cacheSummary(t: CacheTotals): CacheSummary {
  const write = t.cacheWrite ?? 0;
  const hitPercent = t.input > 0 ? Math.round((t.cacheRead / t.input) * 100) : 0;
  const savedTokens = Math.round(
    t.cacheRead * (1 - CACHE_READ_MULT) - write * (CACHE_WRITE_MULT - 1),
  );
  const billedEq =
    t.input -
    t.cacheRead * (1 - CACHE_READ_MULT) +
    write * (CACHE_WRITE_MULT - 1) +
    (t.output ?? 0) * OUTPUT_MULT;
  const savedUsd = t.usd && billedEq > 0 ? (t.usd / billedEq) * savedTokens : 0;
  return { hitPercent, savedTokens, savedUsd };
}
