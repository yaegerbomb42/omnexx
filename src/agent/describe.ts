import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Run } from '../core/run.js';
import type { Codemap } from './codemap.js';

const answerSchema = z.object({
  purposes: z.array(z.object({ path: z.string(), purpose: z.string().max(200) })),
});
const BATCH = 60;

/**
 * Cheap-model one-line purposes for codemap entries (plan §14.2): only for the given paths,
 * batched, budget-gated, and best effort; a failed call just leaves those entries without one.
 */
export async function describeFiles(
  run: Run,
  map: Codemap,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const targets = map.entries
    .filter((e) => paths.includes(e.path) && e.kind === 'source')
    .slice(0, 300);
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const files = await Promise.all(
      batch.map(async (e) => {
        const head = await readFile(join(run.worktree, e.path), 'utf8').then(
          (t) => t.slice(0, 600),
          () => '',
        );
        return `## ${e.path}\nsymbols: ${e.symbols.join(', ')}\n${run.redactor.text(head)}`;
      }),
    );
    const prompt = `Write a one-line purpose (max 15 words) for each file below. Reply only by calling the answer tool.\n\n${files.join('\n\n')}`;
    try {
      const done = await run.cheapComplete(
        {
          system: [{ text: 'You summarize source files for a codebase map.' }],
          tools: [
            {
              name: 'answer',
              description: 'Submit purposes',
              inputSchema: z.toJSONSchema(answerSchema),
            },
          ],
          toolChoice: { type: 'tool', name: 'answer' },
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: 2_000,
          messageBreakpoints: [],
        },
        {
          estimatedInputTokens: Math.ceil(prompt.length / 3) + 500,
          maxOutputTokens: 2_000,
          role: 'cheap',
        },
      );
      if (!done) break;
      const { res } = done;
      const call = res.content.find((b) => b.type === 'tool_use');
      const parsed = answerSchema.safeParse(call?.type === 'tool_use' ? call.input : undefined);
      if (parsed.success)
        for (const p of parsed.data.purposes)
          if (batch.some((b) => b.path === p.path)) out[p.path] = run.redactor.text(p.purpose);
    } catch (err) {
      run.events.emit('codemap.describe_failed', { error: (err as Error).message });
    }
  }
  return out;
}
