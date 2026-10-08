import { z } from 'zod';

/**
 * [search]: semantic code search. Set `embeddings` to a "provider:model" on any OpenAI-compatible
 * /embeddings endpoint (e.g. "mistral:codestral-embed") to give the agent `semantic_search`.
 */
export const search = z
  .strictObject({
    embeddings: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*:\S+$/, 'expected "<provider>:<model>"')
      .optional(),
    /** Files indexed at most (largest repos index their first N tracked files). */
    max_files: z.number().int().positive().default(4_000),
    /** Lines per indexed chunk; chunks overlap by a quarter. */
    chunk_lines: z.number().int().min(10).max(400).default(60),
  })
  .prefault({});
