import { createContext, runInContext } from 'node:vm';
import { z } from 'zod';
import { ok, type Tool, type ToolContext, type ToolOutput } from './types.js';

const inputSchema = z.object({
  code: z.string().describe('JavaScript code to evaluate in the isolated projection REPL.'),
  input: z.unknown().optional().describe('Optional input object/array provided to the script as the `input` global variable.'),
  timeoutMs: z.number().int().min(100).max(10_000).default(3_000).describe('Max execution time in milliseconds.'),
});

type Input = z.infer<typeof inputSchema>;

export const replProjectionTool: Tool<typeof inputSchema> = {
  name: 'repl_projection',
  description:
    'Evaluate pure JS transformation and filtering (map, filter, reduce, regex) in an isolated sandbox. Keeps prompt context strictly append-only.',
  readOnly: true,
  schema: inputSchema,
  run(input: Input, ctx: ToolContext): Promise<ToolOutput> {
    if (ctx.signal?.aborted) {
      return Promise.resolve({
        content: 'REPL execution aborted',
        isError: true,
      });
    }

    try {
      const sandbox = {
        input: input.input ?? null,
        console: {
          log: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        Math,
        JSON,
        RegExp,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
      };

      const context = createContext(sandbox);

      const wrapped = `
        (function() {
          ${input.code}
        })()
      `;

      const result: unknown = runInContext(wrapped, context, {
        timeout: input.timeoutMs,
      });

      const formatted =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      return Promise.resolve(ok(formatted));
    } catch (err) {
      return Promise.resolve({
        content: `REPL execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      });
    }
  },
};
