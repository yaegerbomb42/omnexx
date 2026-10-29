import { z } from 'zod';
import { fail, ok, SUBAGENT_KINDS, type Tool } from './types.js';
import { formatSubagentResult } from '../agent/subagent.js';

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
    'Hand a read-only question to an isolated helper agent with its own fresh context. It reads, searches and queries docs, then returns a compact synthesized summary (findings, key files, confidence) so your primary context window only pays for the answer. Several task calls in one turn run in parallel. Helpers never edit files or run commands (no bash, tests or builds), so never ask one to fix, write or run something.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    if (!ctx.subagent) return fail('task is not available here (helpers cannot start helpers)');
    const result = await ctx.subagent(input.description, input.kind ?? 'explore');
    return ok(formatSubagentResult(result));
  },
};
