import { z } from 'zod';

/**
 * [system_one]: System-1 decision models (TypeSafe Jev and compatible `noul` / `choice` / `score`
 * endpoints) as fast interceptor gates around the agent loop: a destructive-command pre-flight,
 * early stopping once the request is done, tool-output triage, intent routing with speculative
 * read-only pre-fetch, and lazy-patch rejection. Works out of the box: with no key and no Ollama
 * it falls back to calibrated local feature models.
 */
const threshold = (d: number) => z.number().min(0.5).max(0.99).default(d);

export const systemOne = z
  .strictObject({
    enabled: z.boolean().default(true),
    /** auto: Jev when a key or custom endpoint is set, else local Ollama, else calibrated-local. */
    backend: z.enum(['auto', 'typesafe', 'ollama', 'local']).default('auto'),
    base_url: z.string().default('https://api.typesafe.ai/v1/systemone'),
    model: z.string().default('jev-latest'),
    /** Env var holding the System-1 API key (JEV_API_KEY is also read). */
    api_key_env: z.string().default('TYPESAFE_API_KEY'),
    /** Defaults to [kernel] ollama_url. */
    ollama_url: z.string().optional(),
    ollama_model: z.string().default('qwen2.5:3b'),
    timeout_ms: z.number().int().min(50).max(10_000).default(600),
    destructive_threshold: threshold(0.85),
    early_stop_threshold: threshold(0.9),
    speculative_threshold: threshold(0.8),
    patch_placeholder_threshold: threshold(0.85),
    guardrail: z.boolean().default(true),
    early_stop: z.boolean().default(true),
    output_triage: z.boolean().default(true),
    speculative_routing: z.boolean().default(true),
    patch_sanity: z.boolean().default(true),
  })
  .prefault({});

export type SystemOneConfig = z.infer<typeof systemOne>;
