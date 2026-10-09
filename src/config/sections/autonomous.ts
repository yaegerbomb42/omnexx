import { z } from 'zod';

/**
 * [autonomous]: `run --for 8h` keeps improving the repo until the clock runs out. Beyond rounds
 * have no round cap, each one aims at the next focus area, and parked tasks are skipped instead
 * of stopping the run. It ends at the time budget, or after `max_idle_rounds` rounds in a row
 * that found nothing worth doing.
 */
export const autonomous = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Rounds in a row that may add nothing before the run decides the repo is done. */
    max_idle_rounds: z.number().int().min(1).max(50).default(8),
    /** Extra focus areas, tried before the built-in rubric (e.g. "port the CLI to Rust"). */
    focus: z.array(z.string().min(1)).default([]),
  })
  .prefault({});
