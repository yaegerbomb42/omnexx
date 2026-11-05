import { z } from 'zod';

/**
 * [kernel]: Adaptive Runtime Kernel (opt-in). When enabled, the agent loop asks a
 * local Ollama SLM + deterministic telemetry to allocate roles, tools, skills and
 * token budgets per turn, and checkpoints before mutating tools.
 */
export const kernel = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Ollama base URL (no trailing path). */
    ollama_url: z.string().default('http://127.0.0.1:11434'),
    /** Chat model kept warm with keep_alive: -1. */
    ollama_model: z.string().default('qwen2.5:3b'),
    /** Embedding model for the capability index. */
    embed_model: z.string().default('nomic-embed-text'),
    /**
     * Fraction of the active model's context window treated as the attention
     * degradation ceiling when computing context pressure (default 0.65).
     */
    attention_ceiling: z.number().gt(0).lte(1).default(0.65),
  })
  .prefault({});
