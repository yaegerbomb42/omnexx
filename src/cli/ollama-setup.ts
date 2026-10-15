import { totalmem } from 'node:os';
import { readRoles, writeRoles } from '../config/roles.js';
import { resolvePaths } from '../core/paths.js';
import type { CliIO } from './io.js';
import {
  connectOllama,
  DERIVED_PREFIX,
  localCandidates,
  ollamaBase,
  ollamaModels,
  rankOllamaModels,
  showOllamaModel,
  type OllamaModelInfo,
} from './ollama.js';

/**
 * Zero-config Ollama: find the best tool-capable model that's pulled, give it a usable context
 * window, and make it the chat, planner and worker model. When nothing usable is pulled, say
 * which model to pull; when Ollama isn't there, say how to get it.
 */

/** Ollama's default window (2–4k tokens) is too small for an agent; this is what we ask for. */
export const AGENT_NUM_CTX = 32_768;
/** On machines with less memory a smaller window keeps the model from swapping. */
export const SMALL_NUM_CTX = 16_384;
const GIB = 1024 ** 3;
const SMALL_MACHINE_BYTES = 16 * GIB;
/** Enough memory for a 30B mixture-of-experts coding model (~19 GB). */
const BIG_MACHINE_BYTES = 32 * GIB;
const CREATE_TIMEOUT_MS = 60_000;

/** What to pull when nothing usable is installed. */
export interface PullSuggestion {
  model: string;
  /** Download size, for the prompt. */
  size: string;
}

/** Current small, tool-capable coding models in the Ollama library, by machine size. */
export function suggestPull(memoryBytes: number = totalmem()): PullSuggestion {
  return memoryBytes >= BIG_MACHINE_BYTES
    ? { model: 'qwen3-coder', size: '~19 GB' }
    : { model: 'qwen2.5-coder:7b', size: '~4.7 GB' };
}

export type OllamaSetup =
  | {
      kind: 'ready';
      /** The model ref to use, e.g. "ollama:omnexx-qwen3-coder-30b". */
      ref: string;
      /** The pulled model it runs. */
      model: string;
      numCtx: number | undefined;
      /** Whether chat, planner and worker were saved as the model roles. */
      rolesSaved: boolean;
      /** One line saying what was picked. */
      line: string;
    }
  | { kind: 'down'; base: string; line: string }
  | { kind: 'no-model'; pull: PullSuggestion; line: string };

export interface SetupOptions {
  /** Save the pick as the chat, planner, worker and cheap roles (first run: nothing configured). */
  saveRoles?: boolean;
  memoryBytes?: number;
}

/** How to get Ollama going, one line per step. */
export function installHint(base: string): string {
  return [
    `Ollama isn't answering at ${base}.`,
    '  not installed? https://ollama.com/download (macOS: `brew install ollama`)',
    '  installed? start it: open the Ollama app, or run `ollama serve`',
  ].join('\n');
}

function pickNumCtx(info: OllamaModelInfo, memoryBytes: number): number {
  const want = memoryBytes < SMALL_MACHINE_BYTES ? SMALL_NUM_CTX : AGENT_NUM_CTX;
  return info.maxContext ? Math.min(want, info.maxContext) : want;
}

/** The name of omnexx's copy of `model` with a bigger window: qwen3-coder:30b → omnexx-qwen3-coder-30b. */
export function derivedName(model: string): string {
  const base = model.replace(/:latest$/, '');
  return `${DERIVED_PREFIX}${base.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

/**
 * Make (or reuse) a copy of `model` with `num_ctx` set: Ollama's OpenAI-compatible API ignores
 * per-request options, so the window has to live in the model. Undefined when Ollama refuses.
 */
async function withContext(
  fetchFn: typeof fetch,
  base: string,
  model: string,
  numCtx: number,
  pulled: readonly string[],
): Promise<string | undefined> {
  const name = derivedName(model);
  if (pulled.includes(name) || pulled.includes(`${name}:latest`)) return name;
  try {
    const res = await fetchFn(`${base}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: name,
        from: model,
        parameters: { num_ctx: numCtx },
        stream: false,
      }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
    return res.ok ? name : undefined;
  } catch {
    return undefined;
  }
}

async function saveRoles(io: CliIO, ref: string): Promise<void> {
  const paths = resolvePaths(io.env);
  const roles = await readRoles(paths);
  await writeRoles(paths, {
    ...roles,
    models: { ...roles.models, chat: [ref], planner: [ref], worker: [ref], cheap: [ref] },
  });
}

async function describeAll(
  fetchFn: typeof fetch,
  base: string,
  models: readonly string[],
): Promise<OllamaModelInfo[]> {
  const infos = await Promise.all(
    localCandidates(models).map((m) => showOllamaModel(fetchFn, base, m)),
  );
  return infos.filter((i): i is OllamaModelInfo => i !== undefined);
}

/** Detect Ollama, pick and tune the best model, connect it; or say what's missing. */
export async function setupOllama(io: CliIO, opts: SetupOptions = {}): Promise<OllamaSetup> {
  const fetchFn = io.fetch ?? fetch;
  const base = ollamaBase(io.env);
  const memory = opts.memoryBytes ?? totalmem();
  const models = await ollamaModels(fetchFn, base);
  if (!models) return { kind: 'down', base, line: installHint(base) };
  const best = rankOllamaModels(await describeAll(fetchFn, base, models))[0];
  if (!best) {
    const pull = suggestPull(memory);
    const why = localCandidates(models).length
      ? 'none of the models in Ollama can call tools, which the agent needs'
      : 'Ollama has no models yet';
    return { kind: 'no-model', pull, line: `${why}: \`ollama pull ${pull.model}\` (${pull.size})` };
  }
  const numCtx = pickNumCtx(best, memory);
  const tuned = await withContext(fetchFn, base, best.name, numCtx, models);
  await connectOllama(io, base);
  const ref = `ollama:${tuned ?? best.name}`;
  if (opts.saveRoles) await saveRoles(io, ref);
  const ctx = tuned ? `, ${Math.round(numCtx / 1024)}k context` : '';
  const roles = opts.saveRoles ? ' for chat, planning and work' : '';
  return {
    kind: 'ready',
    ref,
    model: best.name,
    numCtx: tuned ? numCtx : undefined,
    rolesSaved: opts.saveRoles === true,
    line: `using Ollama's ${best.name} (local, free, tools${ctx})${roles}. /model to switch`,
  };
}

/** Pull progress: a status line, and percent done when Ollama reports sizes. */
export interface PullProgress {
  status: string;
  percent: number | undefined;
}

interface PullLine {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * `ollama pull <model>` through the API, reporting progress. Resolves when the pull finishes;
 * throws with Ollama's message when it fails.
 */
export async function pullOllamaModel(
  io: CliIO,
  model: string,
  onProgress: (p: PullProgress) => void,
): Promise<void> {
  const base = ollamaBase(io.env);
  const res = await (io.fetch ?? fetch)(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama couldn't pull ${model} (HTTP ${res.status})`);
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of res.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const raw of lines) reportPullLine(raw, model, onProgress);
  }
  reportPullLine(buffered, model, onProgress);
}

function reportPullLine(raw: string, model: string, onProgress: (p: PullProgress) => void): void {
  if (!raw.trim()) return;
  let line: PullLine;
  try {
    line = JSON.parse(raw) as PullLine;
  } catch {
    return;
  }
  if (line.error) throw new Error(`Ollama couldn't pull ${model}: ${line.error}`);
  const percent =
    line.total && line.completed !== undefined
      ? Math.floor((line.completed / line.total) * 100)
      : undefined;
  onProgress({ status: line.status ?? '', percent });
}
