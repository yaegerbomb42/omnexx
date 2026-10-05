import { z } from 'zod';
import { ROUTE_ACTIONS } from '../../router/actions.js';

/**
 * [router]: which model handles each action. `auto` asks the judge (Nimble) when one is
 * configured and otherwise uses the role table; `rules` never asks; `judge` always asks the
 * configured judge, even an `llm` one (which costs a cheap-model call per decision).
 */
export const router = z
  .strictObject({
    kind: z.enum(['auto', 'rules', 'judge']).default('auto'),
    /** Take the judge's pick only at or above this probability. */
    min_probability: z.number().min(0).max(1).default(0.55),
    /** Always use this model for an action, e.g. pin.plan = "anthropic:opus". */
    pin: z
      .partialRecord(z.enum(ROUTE_ACTIONS), z.string().regex(/^[a-z][a-z0-9_-]*:\S+$/))
      .default({}),
  })
  .prefault({});
