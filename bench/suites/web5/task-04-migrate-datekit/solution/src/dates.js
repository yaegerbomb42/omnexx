import { DateKit } from '../vendor/datekit/index.js';

/** "31/12/2025" (UK order) to "2025-12-31". Throws on an impossible date. */
export function ukToIso(uk) {
  return DateKit.from(uk, { pattern: 'dd/MM/yyyy' }).format('yyyy-MM-dd');
}

/** The ISO date `n` days after `iso` ("2025-12-31", 1 gives "2026-01-01"). */
export function shiftIso(iso, n) {
  return DateKit.from(iso, { pattern: 'yyyy-MM-dd' }).plus({ days: n }).format('yyyy-MM-dd');
}
