import { z } from 'zod';

/**
 * [plan]: how much planning a run gets before the work starts.
 * - mode "auto": short goals try the fast path first, long ones (a spec, a multi-hour build) plan.
 * - mode "fast": always try the whole goal as one task first; plan only if that fails.
 * - mode "full": always plan milestones and tasks first (the pre-0.10 behaviour).
 * The fast path is one worker cycle on the whole goal, gated and reviewed like any other; after
 * `fast_attempts` cycles without the goal's checks passing, the planner takes over from there.
 */
export const plan = z
  .strictObject({
    mode: z.enum(['auto', 'fast', 'full']).default('auto'),
    /** writing: prose (a book, a report), no tests; auto detects it from the goal. */
    kind: z.enum(['auto', 'code', 'writing']).default('auto'),
    fast_attempts: z.number().int().min(1).max(5).default(2),
    /** In auto mode, goals longer than this many characters plan first. */
    fast_max_goal_chars: z.number().int().positive().default(2_500),
    /** Helpers the planner may run at once while exploring (0: none, it reads on its own). */
    helpers: z.number().int().min(0).max(8).optional(),
    /** Upper bound on milestones in the first plan; unset lets the planner size it to the goal. */
    milestones: z.number().int().min(1).max(30).optional(),
  })
  .prefault({});
