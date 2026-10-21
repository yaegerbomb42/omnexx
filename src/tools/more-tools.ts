import { z } from 'zod';
import { fail, ok, type Tool } from './types.js';

/**
 * Rarely called read-only tools that `[context] lazy_tools` moves behind `more_tools`, so their
 * schemas stay out of the cached prefix that every cold start and cache miss pays for in full.
 */
export const DEFERRED_TOOLS: ReadonlySet<string> = new Set([
  'remember',
  'running_context',
  'query_artifact',
  'recall',
  'outline',
  'read_symbol',
]);

const firstSentence = (text: string): string => {
  const end = text.search(/[.!?](\s|$)/);
  return (end < 0 ? text : text.slice(0, end + 1)).replace(/\s+/g, ' ').trim();
};

/** One stable tool that describes a deferred tool (no `input`) or runs it (with `input`). */
export function moreToolsTool(deferred: readonly Tool[]): Tool {
  const byName = new Map(deferred.map((t) => [t.name, t]));
  const names = [...byName.keys()];
  const schema = z.strictObject({
    tool: z.enum(names as [string, ...string[]]).describe('The tool to describe or run'),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The tool's arguments; leave out to get its description and input schema"),
  });
  const listing = deferred.map((t) => `- ${t.name}: ${firstSentence(t.description)}`).join('\n');
  return {
    name: 'more_tools',
    description: `Describe or run a tool that isn't listed. Call it once without input to see the arguments, then with input.\n${listing}`,
    schema,
    readOnly: true,
    async run({ tool, input }: z.infer<typeof schema>, ctx) {
      const t = byName.get(tool);
      if (!t) return fail(`unknown tool "${tool}"; one of: ${names.join(', ')}`);
      const shape = JSON.stringify(z.toJSONSchema(t.schema, { target: 'draft-7' }));
      if (input === undefined) return ok(`${t.name}: ${t.description}\n\nInput schema: ${shape}`);
      const parsed = t.schema.safeParse(t.normalize ? t.normalize(input) : input);
      if (!parsed.success)
        return fail(
          `invalid input for ${t.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n\nInput schema: ${shape}`,
        );
      return t.run(parsed.data, ctx);
    },
  };
}
