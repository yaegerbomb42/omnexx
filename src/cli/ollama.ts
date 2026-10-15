import { connect } from './connect.js';
import type { CliIO } from './io.js';
import { UsageError } from '../errors.js';

export const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_PORT = '11434';
const PROBE_TIMEOUT_MS = 800;
const SHOW_TIMEOUT_MS = 3_000;

/** Coding models worth defaulting to, best first; any other pulled model is used after these. */
const PREFERRED = [
  /qwen3-coder-next/,
  /qwen3-coder/,
  /devstral/,
  /gpt-oss/,
  /qwen3\.\d/,
  /qwen2\.5-coder/,
  /deepseek-coder/,
  /coder|code/,
  /qwen3/,
];

/** Models served from Ollama's cloud: billed and remote, so never picked on their own. */
const CLOUD = /[:-]cloud$/;

/** Models omnexx made itself (a pulled model with a bigger context window). */
export const DERIVED_PREFIX = 'omnexx-';

/**
 * Where Ollama listens: OLLAMA_HOST when set (`host`, `host:port`, `:port` or a URL; a bind-all
 * 0.0.0.0 means this machine), else localhost:11434.
 */
export function ollamaBase(env: NodeJS.ProcessEnv): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return OLLAMA_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    const host = !u.hostname || u.hostname === '0.0.0.0' ? '127.0.0.1' : u.hostname;
    const port = u.port || (/^https?:\/\//i.test(raw) ? '' : OLLAMA_PORT);
    return `${u.protocol}//${host}${port ? `:${port}` : ''}`;
  } catch {
    return OLLAMA_URL;
  }
}

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

/** What `/api/show` says about one pulled model. */
export interface OllamaModelInfo {
  name: string;
  /** Can call tools (the agent can't work without it). */
  tools: boolean;
  /** The longest context the model supports, in tokens, when Ollama reports it. */
  maxContext: number | undefined;
  /** Parameter count in billions, when reported ("30.5B" → 30.5). */
  paramsB: number | undefined;
}

interface ShowBody {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { parameter_size?: string };
}

function parseParams(size: string | undefined): number | undefined {
  const m = /^([\d.]+)\s*([BM])/i.exec(size ?? '');
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2]?.toUpperCase() === 'M' ? n / 1_000 : n;
}

/** One model's capabilities, or undefined when Ollama can't describe it. */
export async function showOllamaModel(
  fetchFn: typeof fetch,
  base: string,
  name: string,
): Promise<OllamaModelInfo | undefined> {
  try {
    const res = await fetchFn(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as ShowBody;
    const ctxKey = Object.keys(body.model_info ?? {}).find((k) => k.endsWith('.context_length'));
    const ctx = ctxKey ? body.model_info?.[ctxKey] : undefined;
    return {
      name,
      tools: (body.capabilities ?? []).includes('tools'),
      maxContext: typeof ctx === 'number' && ctx > 0 ? ctx : undefined,
      paramsB: parseParams(body.details?.parameter_size),
    };
  } catch {
    return undefined;
  }
}

function preference(name: string): number {
  const i = PREFERRED.findIndex((p) => p.test(name));
  return i === -1 ? PREFERRED.length : i;
}

/** Local models omnexx may pick on its own: not cloud-billed, not one omnexx derived. */
export function localCandidates(models: readonly string[]): string[] {
  return models.filter((m) => !CLOUD.test(m) && !m.startsWith(DERIVED_PREFIX));
}

/**
 * Tool-capable models, best first: known-good coding families, then bigger models, then longer
 * context. Models without tool calling are dropped.
 */
export function rankOllamaModels(infos: readonly OllamaModelInfo[]): OllamaModelInfo[] {
  return infos
    .filter((m) => m.tools)
    .toSorted(
      (a, b) =>
        preference(a.name) - preference(b.name) ||
        (b.paramsB ?? 0) - (a.paramsB ?? 0) ||
        (b.maxContext ?? 0) - (a.maxContext ?? 0),
    );
}

/** `wanted` when pulled (with or without its `:latest` tag), else the best coding model there is. */
export function pickOllamaModel(models: readonly string[], wanted?: string): string | undefined {
  if (wanted) return models.find((m) => m === wanted || m === `${wanted}:latest`);
  const local = localCandidates(models);
  return local.toSorted((a, b) => preference(a) - preference(b))[0];
}

/**
 * `omnexx --ollama [model]` with a model named: connect the local Ollama (once) and return the
 * model ref. Throws a usage error that says what to do when Ollama isn't running or lacks it.
 */
export async function useOllama(io: CliIO, wanted?: string): Promise<string> {
  const base = ollamaBase(io.env);
  const models = await ollamaModels(io.fetch ?? fetch, base);
  if (!models)
    throw new UsageError(
      `Ollama isn't answering at ${base}`,
      'install it from https://ollama.com/download, start it (`ollama serve`), then `ollama pull qwen3-coder`',
    );
  const model = pickOllamaModel(models, wanted);
  if (!model)
    throw new UsageError(
      wanted ? `Ollama has no model "${wanted}"` : 'Ollama has no models yet',
      `ollama pull ${wanted ?? 'qwen3-coder'}`,
    );
  await connectOllama(io, base);
  return `ollama:${model}`;
}

/** Add the `ollama` endpoint to user config (a no-op when it's already there). */
export async function connectOllama(io: CliIO, base: string): Promise<void> {
  if (base === OLLAMA_URL) await connect(io, 'ollama');
  else await connect(io, `${base}/v1`, undefined, { name: 'ollama' });
}
