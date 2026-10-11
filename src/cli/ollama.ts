import { connect } from './connect.js';
import type { CliIO } from './io.js';
import { UsageError } from '../errors.js';

export const OLLAMA_URL = 'http://localhost:11434';
const PROBE_TIMEOUT_MS = 800;

/** Coding models worth defaulting to, best first; any other pulled model is used after these. */
const PREFERRED = [
  /qwen3-coder/,
  /qwen2\.5-coder/,
  /devstral/,
  /gpt-oss/,
  /deepseek-coder/,
  /coder/,
  /qwen3/,
];

/** The models a running Ollama has pulled, or undefined when nothing answers. */
export async function ollamaModels(
  fetchFn: typeof fetch = fetch,
  base = OLLAMA_URL,
): Promise<string[] | undefined> {
  try {
    const res = await fetchFn(`${base}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  } catch {
    return undefined;
  }
}

/** `wanted` when pulled (with or without its `:latest` tag), else the best coding model there is. */
export function pickOllamaModel(models: readonly string[], wanted?: string): string | undefined {
  if (wanted) return models.find((m) => m === wanted || m === `${wanted}:latest`);
  for (const p of PREFERRED) {
    const hit = models.find((m) => p.test(m));
    if (hit) return hit;
  }
  return models[0];
}

/**
 * `omnexx --ollama [model]`: connect the local Ollama (once) and return the model ref to use.
 * Throws a usage error that says what to do when Ollama isn't running or has no such model.
 */
export async function useOllama(io: CliIO, wanted?: string): Promise<string> {
  const models = await ollamaModels(io.fetch ?? fetch);
  if (!models)
    throw new UsageError(
      `Ollama isn't answering at ${OLLAMA_URL}`,
      'install it from https://ollama.com, start it, then `ollama pull qwen2.5-coder`',
    );
  const model = pickOllamaModel(models, wanted);
  if (!model)
    throw new UsageError(
      wanted ? `Ollama has no model "${wanted}"` : 'Ollama has no models yet',
      `ollama pull ${wanted ?? 'qwen2.5-coder'}`,
    );
  await connect(io, 'ollama');
  return `ollama:${model}`;
}
