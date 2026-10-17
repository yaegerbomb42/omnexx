import { z } from 'zod';
import { CONTEXT_KINDS } from '../core/running-context.js';
import { fail, ok, type Tool } from './types.js';

const schema = z.strictObject({
  kind: z
    .enum(CONTEXT_KINDS)
    .describe(
      'solution: what worked and why · dead_end: not worth retrying · progress, checkpoint, summary: where things stand',
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
    "Add a short entry to this task's running context, shown again every cycle and after trimming. Send it alongside other calls.",
  schema,
  readOnly: true,
  async run(input, ctx) {
    if (!ctx.runningContext) return fail('no running context here');
    await ctx.runningContext.add(input.kind, input.text);
    return ok(`added a ${input.kind} entry to the running context`);
  },
};
