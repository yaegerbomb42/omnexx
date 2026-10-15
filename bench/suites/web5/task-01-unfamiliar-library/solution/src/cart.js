import { createTally } from '../vendor/tallyhq/index.js';

/**
 * Total of a cart's prices (decimal strings such as "19.99"), rounded to cents with banker's
 * rounding (half to even), as a string like "42.10". Must use the vendored tallyhq library.
 */
export function cartTotal(prices) {
  const tally = createTally({ mode: 'even', places: 2 });
  for (const p of prices) tally.add(p);
  return tally.total().value;
}
