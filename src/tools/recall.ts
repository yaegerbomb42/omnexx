import { z } from 'zod';
import { bm25, runHistory } from '../agent/recall.js';
import { ok, type Tool } from './types.js';

const schema = z.strictObject({
  query: z.string().min(2).describe('Words to look for, e.g. an error message or file name'),
  limit: z.number().int().min(1).max(10).optional().describe('Results to return (default 5)'),
});

const SNIPPET_CHARS = 800;

export const recallTool: Tool<typeof schema> = {
  name: 'recall',
  description:
    "Search this run's full history: every earlier cycle's progress, evidence from rejected attempts on any task, lessons, and command and gate logs. Use it before redoing work or when an error looks familiar; your context only shows the latest few cycles.",
  schema,
  readOnly: true,
  async run(input, ctx) {
    const hits = bm25(await runHistory(ctx.store), input.query, input.limit ?? 5);
    if (!hits.length) return ok(`nothing in the run history matches "${input.query}"`);
    return ok(
      hits
        .map(({ doc }) => {
          const t = ctx.redactor.text(doc.text.trim());
          return `## ${doc.source}\n${t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t}`;
        })
        .join('\n\n'),
    );
  },
};
