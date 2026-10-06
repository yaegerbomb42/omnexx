import { z } from 'zod';
import { fail, ok, SUBAGENT_KINDS, type Tool } from './types.js';

const schema = z.strictObject({
  description: z
    .string()
    .min(10)
    .describe('What to find out, with enough context to work alone, and what to report back'),
  kind: z
    .enum(SUBAGENT_KINDS)
    .optional()
    .describe(
      'explore: find code and how it works (default); research: docs and the web; review: critique a diff or design',
    ),
});

export const taskTool: Tool<typeof schema> = {
  name: 'task',
  description:
    'Hand a read-only question to a helper agent with its own fresh context. It reads, searches and runs read-only tools, then returns a short summary, so your context only pays for the answer. Several task calls in one turn run in parallel. Helpers never edit files.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    if (!ctx.subagent) return fail('task is not available here (helpers cannot start helpers)');
    return ok(await ctx.subagent(input.description, input.kind ?? 'explore'));
  },
};
