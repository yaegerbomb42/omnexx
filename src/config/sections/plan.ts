import { z } from 'zod';

/**
 * [plan]: how much planning a run gets before the work starts.
 * - mode "auto": short goals try the fast path first, long ones (a spec, a multi-hour build) plan.
 * - mode "fast": always try the whole goal as one task first; plan only if that fails.
 * - mode "full": always plan milestones and tasks first (the pre-0.10 behaviour).
 * The fast path is one worker cycle on the whole goal, gated and reviewed like any other; after
 * `fast_attempts` cycles without the goal's checks passing, the planner takes over from there.
 *
 * `loop` runs a task as one think-first conversation (core/think-loop.ts): explore and write an
 * analysis with the planner's models, then carry it out with the worker's, checking the gates
 * after each pass and fixing forward on failure; re-think in place when stuck; one review at the
 * end. "fast" does that for the fast path, "all" for every planned task too, "off" is one plain
 * worker pass per cycle.
 */
export const plan = z
  .strictObject({
    mode: z.enum(['auto', 'fast', 'full']).default('auto'),
    /** writing: prose (a book, a report), no tests; auto detects it from the goal. */
    kind: z.enum(['auto', 'code', 'writing']).default('auto'),
    fast_attempts: z.number().int().min(1).max(5).default(2),
    loop: z.enum(['fast', 'all', 'off']).default('fast'),
    /** Execute-and-check passes one loop session may take before it is judged on what it did. */
    loop_rounds: z.number().int().min(1).max(20).default(6),
    /** Times a loop session may stop to re-think when stuck. */
    loop_rethinks: z.number().int().min(0).max(5).default(2),
    /**
     * Doom-loop rewinds per loop session: when the checks get worse twice in a row, or a failure
     * set comes back (fixing A breaks B and back), the tree goes back to the best pass so far,
     * the turns since become a short tombstone, and the agent re-thinks. 0 turns it off.
     */
    loop_rewinds: z.number().int().min(0).max(5).default(2),
    /** Re-runs of a loop check's new test failures to tell flakes apart (flakes are quarantined). */
    loop_flaky_reruns: z.number().int().min(0).max(3).default(2),
    /**
     * Turns a think step may explore before it must write its analysis (bench hard10: thinking
     * took 12-34 turns, half of each run, mostly experiments the execute phase repeated).
     */
    loop_think_turns: z.number().int().min(1).max(40).default(8),
    /**
     * Loop sessions start the gates in the background ~1.5 s after the last edit, so a check
     * can reuse the result while the model was still talking. Reused only for the exact same tree.
     */
    speculative_checks: z.boolean().default(true),
    /** In auto mode, goals longer than this many characters plan first. */
    fast_max_goal_chars: z.number().int().positive().default(2_500),
    /** Helpers the planner may run at once while exploring (0: none, it reads on its own). */
    helpers: z.number().int().min(0).max(8).optional(),
    /** Upper bound on milestones in the first plan; unset lets the planner size it to the goal. */
    milestones: z.number().int().min(1).max(30).optional(),
    /**
     * Upper bound on milestones from the task-effort setting. Applies only when the run plans;
     * it never turns planning on (setting milestones does).
     */
    milestone_cap: z.number().int().min(1).max(30).optional(),
  })
  .prefault({});
