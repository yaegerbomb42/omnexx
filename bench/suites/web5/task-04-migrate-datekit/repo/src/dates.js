import { parse, format, addDays } from '../vendor/datekit/index.js';

/** "31/12/2025" (UK order) to "2025-12-31". Throws on an impossible date. */
export function ukToIso(uk) {
  return format(parse(uk, 'DD/MM/YYYY'), 'YYYY-MM-DD');
}

/** The ISO date `n` days after `iso` ("2025-12-31", 1 gives "2026-01-01"). */
export function shiftIso(iso, n) {
  return format(addDays(parse(iso, 'YYYY-MM-DD'), n), 'YYYY-MM-DD');
}
