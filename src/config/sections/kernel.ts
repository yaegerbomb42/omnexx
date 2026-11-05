import { z } from 'zod';

/**
 * [kernel]: Adaptive Runtime Kernel (on by default). Dynamically selects which
 * MCP tools / skills from a large catalog are mounted into the model context,
 * with local-Ollama or System-1 (TF-IDF) routing, checkpoints, and telemetry.
 * Set enabled = false to opt out.
 */
export const kernel = z
  .strictObject({
    enabled: z.boolean().default(true),
    ollama_url: z.string().default('http://127.0.0.1:11434'),
    ollama_model: z.string().default('qwen2.5:3b'),
    embed_model: z.string().default('nomic-embed-text'),
    attention_ceiling: z.number().gt(0).lte(1).default(0.65),
    /** Max catalog capabilities mounted into context at once. */
    max_mounted: z.number().int().min(1).max(64).default(8),
    /** Re-run catalog selection every N turns (0 = only on task/friction). */
    reselect_every: z.number().int().min(0).max(100).default(4),
    /** Pull the official MCP Registry on warm (falls back to bundled snapshot offline). */
    registry: z.boolean().default(true),
    /** Index locally configured MCP servers + on-disk skills. */
    local_discovery: z.boolean().default(true),
    /** Enrich search_capabilities via the real SkillMD public API. */
    public_skills: z.boolean().default(true),
  })
  .prefault({});
