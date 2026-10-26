/**
 * The CLI side of the shared token scale (design spec §3.1–3.2).
 * Ink measures spacing in cells, not pixels, so the spacing scale is the small set
 * of cell steps the panels use; border styles map onto the radius tiers.
 */
export const SPACE = {
  /** 0 cells — flush. */
  none: 0,
  /** 1 cell — tight (card padding, list gutters). */
  sm: 1,
  /** 2 cells — comfortable (panel gutters). */
  md: 2,
  /** 3 cells — page-level gutters. */
  lg: 3,
} as const;

export const BORDER = {
  /** Mid-tier surface: buttons, chips, inputs (radius-md). */
  card: 'single',
  /** Elevated surface: panels, modals (radius-lg). */
  panel: 'round',
} as const;
