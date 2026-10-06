import { z } from 'zod';

/**
 * [beyond]: after the goal is met, keep improving like a top engineer would (hardening, tests,
 * security, performance, docs), each improvement backed by a new or tighter check. The run ends
 * when the planner finds nothing worth doing, after `max_rounds`, or when the budget runs low.
 */
export const beyond = z
  .strictObject({
    enabled: z.boolean().default(true),
    max_rounds: z.number().int().min(0).max(20).default(3),
    /** Don't start a round with less than this fraction of the money or time budget left. */
    min_budget_left: z.number().min(0).max(1).default(0.2),
  })
  .prefault({});
