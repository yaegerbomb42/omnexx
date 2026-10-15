import { z } from 'zod';

/**
 * [review]: before a change that passed every gate is committed, a separate model reviews the
 * diff against the task and the goal; findings at `block_on` severity or worse reject it. And
 * before a run may finish, an auditor checks the result against the goal's "done when" list.
 * Both fail open: a reviewer outage never blocks work.
 */
export const review = z
  .strictObject({
    enabled: z.boolean().default(true),
    block_on: z.enum(['blocker', 'major']).default('blocker'),
    /** Models for the per-change review (frequent: the worker's chain keeps it affordable). */
    review_models: z.enum(['cheap', 'worker', 'planner']).default('worker'),
    /** Models for the pre-finish audit (rare, judgement-heavy: the planner's chain). */
    audit_models: z.enum(['cheap', 'worker', 'planner']).default('planner'),
    /** Diffs larger than this are cut (head and tail kept) before review. */
    max_diff_chars: z.number().int().positive().default(40_000),
    /** Refuse plans whose task checks only look for files or text (`test -f`, `grep`). */
    strict_checks: z.boolean().default(true),
    /** Audit the finished work before the run may end. */
    audit: z.boolean().default(true),
    /** Audit rounds that may add work before the run finishes anyway. */
    max_audits: z.number().int().min(1).max(10).default(3),
    /**
     * Cycles one audit round's work may take. Its gates passed before the audit, so what is still
     * open after this is skipped and the run finishes on the last green commit (bench runs met
     * the goal in cycle 1, then spent 20+ cycles on audit-added work).
     */
    audit_max_cycles: z.number().int().min(1).max(100).default(4),
    /**
     * Spec-first acceptance tests: before a run may finish, a model that sees only the goal and
     * the public interface (signatures, not bodies) writes tests for the boundaries and
     * interactions between requirements; failures go back to the worker. `auto` runs them for
     * goals above the fast-path size or with several listed requirements (bench task-10: the
     * worker's code and its own tests agreed on a wrong behaviour that review and audit missed).
     */
    spec_tests: z.enum(['auto', 'on', 'off']).default('auto'),
    /** Models that write the spec tests and judge the worker's disputes of them. */
    spec_tests_models: z.enum(['cheap', 'worker', 'planner']).default('planner'),
    /** Fix rounds the spec tests may send back to the worker before the run finishes anyway. */
    spec_tests_max_rounds: z.number().int().min(1).max(5).default(2),
  })
  .prefault({});
