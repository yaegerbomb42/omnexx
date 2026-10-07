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
    /** Diffs larger than this are cut (head and tail kept) before review. */
    max_diff_chars: z.number().int().positive().default(40_000),
    /** Refuse plans whose task checks only look for files or text (`test -f`, `grep`). */
    strict_checks: z.boolean().default(true),
    /** Audit the finished work before the run may end. */
    audit: z.boolean().default(true),
    /** Audit rounds that may add work before the run finishes anyway. */
    max_audits: z.number().int().min(1).max(10).default(3),
  })
  .prefault({});
