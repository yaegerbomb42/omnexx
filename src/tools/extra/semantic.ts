import { z } from 'zod';
import { SemanticIndex } from '../../agent/semantic.js';
import { findProviderKey } from '../../auth/keys.js';
import type { OmnexxConfig } from '../../config/schema.js';
import { resolvePaths } from '../../core/paths.js';
import { fail, ok, type Tool } from '../types.js';
import type { ToolSource } from './types.js';

const schema = z.strictObject({
  query: z
    .string()
    .min(3)
    .describe(
      'What the code does, in words: "where failed payments are retried", "auth middleware"',
    ),
  limit: z.number().int().min(1).max(15).optional().describe('Results (default 6)'),
});

const SNIPPET_CHARS = 1_200;

function semanticTool(config: OmnexxConfig, ref: string): Tool<typeof schema> {
  const cut = ref.indexOf(':');
  const provider = ref.slice(0, cut);
  const model = ref.slice(cut + 1);
  return {
    name: 'semantic_search',
    description:
      'Find code by meaning, not exact text: describe what it does and get the most relevant chunks with file and line numbers. Use it to find where something is implemented before writing new code; use search for exact names.',
    schema,
    readOnly: true,
    async run(input, ctx) {
      const ep = config.providers.endpoints[provider];
      if (!ep) return fail(`semantic search: no [providers.endpoints.${provider}] for ${ref}`);
      const paths = resolvePaths(process.env);
      const key = (await findProviderKey(paths, process.env, provider, ep.api_key_env))?.key;
      const index = await SemanticIndex.open(
        paths,
        ctx.jail.root,
        { baseUrl: ep.base_url, apiKey: key, model },
        { maxFiles: config.search.max_files, chunkLines: config.search.chunk_lines },
      );
      try {
        const r = await index.refresh();
        const hits = await index.search(input.query, input.limit ?? 6);
        if (!hits.length) return ok(`nothing indexed matches "${input.query}"`);
        const plural = r.embedded === 1 ? '' : 's';
        const head = r.embedded ? `(indexed ${r.embedded} changed file${plural})\n\n` : '';
        const shown = hits.map((h) => {
          const t = ctx.redactor.text(h.text);
          const body = t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
          return `## ${h.path}:${h.start}-${h.end} (score ${h.score.toFixed(2)})\n${body}`;
        });
        return ok(head + shown.join('\n\n'));
      } catch (err) {
        return fail(`semantic search failed: ${(err as Error).message}; use search instead`);
      }
    },
  };
}

/** Only offered when [search] embeddings names a model. */
export const source: ToolSource = {
  load: (config) =>
    config.search.embeddings ? [semanticTool(config, config.search.embeddings)] : [],
};
