import { z } from 'zod';
import { CONTEXT_KINDS } from '../core/running-context.js';
import { fail, ok, type Tool } from './types.js';

const schema = z.strictObject({
  kind: z
    .enum(CONTEXT_KINDS)
    .describe(
      'progress: what you just did · solution: what worked and why · dead_end: what failed and why not to retry it · checkpoint: where the task stands now · summary: the state in a few lines',
    ),
  text: z.string().min(3).max(2_000),
});

/**
 * The agent's own living memory for the current task. It is shown again at the start of every
 * cycle, so writing here is how the work survives a fresh context.
 */
export const runningContextTool: Tool<typeof schema> = {
  name: 'running_context',
  description:
    'Add to your running context for this task: a living memory shown to you again at the start of every cycle and after the context is trimmed. Record progress after each meaningful step, the solution when something works, dead ends so you never retry them, and a checkpoint of where you are before you finish. Short, concrete, with file paths.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    if (!ctx.runningContext) return fail('no running context here');
    await ctx.runningContext.add(input.kind, input.text);
    return ok(`added a ${input.kind} entry to the running context`);
  },
};
