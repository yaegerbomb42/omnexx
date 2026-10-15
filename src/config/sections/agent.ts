import { z } from 'zod';
import { MAX_LEVEL, MIN_LEVEL, TIME_CHOICES } from '../../core/agent-levels.js';

const level = z.number().int().min(MIN_LEVEL).max(MAX_LEVEL).optional();

/**
 * [agent]: the five sliders the agent manages itself by (CLI `/settings`, the VS Code "Agent"
 * card). Usually written by those UIs to agent-settings.json; a project may pin them here.
 * Unset levels change nothing. Set ones drive [plan] loop_*, [context] compaction, budget
 * max_hours and the output cap (see config/agent-settings.ts and docs/config.md).
 */
export const agent = z
  .strictObject({
    /** 1 = quick MVP, 10 = build a monolith: planning depth, scope, think turns, milestones. */
    task_effort: level,
    /** Thinking depth per model call: reasoning_effort / thinking budget. */
    turn_effort: level,
    /** 1-10: context budget 5k…500k tokens, clamped to the model's window. */
    context_level: level,
    /** Time wanted on a task: sets budget.max_hours and how the agent sizes its plan. */
    time: z.enum(TIME_CHOICES).optional(),
    /** Output cap per model call (providers.anthropic.max_tokens). */
    max_tokens_per_turn: z.number().int().min(256).max(128_000).optional(),
    /** Offer the settings at every start (CLI chat and the VS Code panel). */
    ask_on_start: z.boolean().default(true),
  })
  .prefault({});
