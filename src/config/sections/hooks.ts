import { z } from 'zod';
import { durationString } from '../duration.js';

/** When a hook fires. `pre_*` hooks may veto (non-zero exit blocks the action). */
export const HOOK_EVENTS = ['pre_tool', 'post_tool', 'pre_commit', 'cycle_end', 'run_end'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const hookSchema = z.strictObject({
  on: z.enum(HOOK_EVENTS),
  run: z.string().min(1),
  /** Glob (`*`, `?`) over the payload's tool name; only tool events carry one. */
  match: z.string().optional(),
  timeout: durationString.default('30s'),
});
export type HookConfig = z.infer<typeof hookSchema>;

/** `[[hooks]]` array-of-tables entries, in file order; runHooks runs them in this order. */
export const hooks = z.array(hookSchema).default([]);
