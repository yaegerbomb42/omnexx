/**
 * System-1 client with 3-tier backend resolution:
 *   1. `jev-http`: the native `POST /v1/systemone` endpoint (TypeSafe Jev, or any Kev / Clef /
 *      OpenRouter System-1 server at `base_url`), when a key or a custom endpoint is set.
 *   2. `ollama-s1`: a local Ollama model answering the same schema via `format: "json"`.
 *   3. `calibrated-local`: deterministic feature models, always available, and the fallback
 *      whenever a remote tier times out or errors.
 * Identical requests are memoized (sha256 of state + questions, 256-entry LRU).
 */
import { createHash } from 'node:crypto';
import { localAnswers } from './local-scorer.js';
import { normalizeAnswer } from './normalize.js';
import type {
  Answers,
  ChoiceAnswer,
  ScoreAnswer,
  SystemOneBackendKind,
  SystemOneGate,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from './types.js';
import { choice, noul, score } from './types.js';

export const DEFAULT_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_SYSTEM_ONE_MODEL = 'jev-latest';
/** Jev list price per input token (USD); local backends cost nothing. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const CACHE_SIZE = 256;
const OLLAMA_PROBE_MS = 500;
const OLLAMA_OFFLINE_MS = 60_000;
const OLLAMA_PREFERRED = 'kev:4b';

export type SystemOneBackendSetting = 'auto' | 'typesafe' | 'ollama' | 'local';

export interface SystemOneClientOptions {
  backend?: SystemOneBackendSetting;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SystemOneStats {
  calls: number;
  cacheHits: number;
  fallbacks: number;
  inputTokens: number;
  usd: number;
  byBackend: Record<SystemOneBackendKind, number>;
  latencyP50Ms: number;
}

type AnyAnswer = ReturnType<typeof normalizeAnswer>;

function trimSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export class SystemOneClient {
  private readonly opts: Required<Omit<SystemOneClientOptions, 'apiKey'>> & { apiKey?: string };
  private readonly cache = new Map<
    string,
    { model: string; answers: Record<string, AnyAnswer>; backend: SystemOneBackendKind }
  >();
  private ollamaOfflineUntil = 0;
  private ollamaModelResolved: string | undefined;
  private readonly latencies: number[] = [];
  private readonly counters: Omit<SystemOneStats, 'latencyP50Ms'> = {
    calls: 0,
    cacheHits: 0,
    fallbacks: 0,
    inputTokens: 0,
    usd: 0,
    byBackend: { 'jev-http': 0, 'ollama-s1': 0, 'calibrated-local': 0 },
  };

  constructor(opts: SystemOneClientOptions = {}) {
    this.opts = {
      backend: opts.backend ?? 'auto',
      baseUrl: opts.baseUrl ?? DEFAULT_SYSTEM_ONE_URL,
      model: opts.model ?? DEFAULT_SYSTEM_ONE_MODEL,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ollamaUrl: trimSlashes(opts.ollamaUrl ?? 'http://127.0.0.1:11434'),
      ollamaModel: opts.ollamaModel ?? 'qwen2.5:3b',
      timeoutMs: opts.timeoutMs ?? 600,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      now: opts.now ?? (() => performance.now()),
    };
  }

  /** The tier a request tries first (before any fallback). */
  get primary(): SystemOneBackendKind {
    const { backend } = this.opts;
    if (backend === 'local') return 'calibrated-local';
    if (backend === 'ollama') return 'ollama-s1';
    if (backend === 'typesafe' || this.httpConfigured) return 'jev-http';
    return 'ollama-s1';
  }

  get model(): string {
    return this.opts.model;
  }

  /** A key, or a non-default endpoint (a local Kev / Clef server needs no key). */
  get httpConfigured(): boolean {
    return Boolean(this.opts.apiKey) || this.opts.baseUrl !== DEFAULT_SYSTEM_ONE_URL;
  }

  /** A human label for the active tier: "Jev (jev-latest)", "Ollama S1", "System-1 Local". */
  label(): string {
    const p = this.primary;
    if (p === 'jev-http') return `Jev (${this.opts.model})`;
    if (p === 'ollama-s1' && this.opts.now() < this.ollamaOfflineUntil) return 'System-1 Local';
    return p === 'ollama-s1' ? 'Ollama S1' : 'System-1 Local';
  }

  /** `label()` after checking whether local Ollama is actually up (the CLI shows this). */
  async probeLabel(): Promise<string> {
    if (this.primary === 'ollama-s1') await this.ollamaModel();
    return this.label();
  }

  stats(): SystemOneStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ...this.counters,
      byBackend: { ...this.counters.byBackend },
      latencyP50Ms: sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0,
    };
  }

  /** Evaluate every question in one forward pass. */
  async systemOne<Q extends Record<string, SystemOneQuestion>>(
    req: SystemOneRequest<Q>,
  ): Promise<SystemOneResponse<Q>> {
    const started = this.opts.now();
    const gate = req.gate ?? 'adhoc';
    const body = JSON.stringify({ state: req.state, questions: req.questions });
    const key = createHash('sha256').update(body).digest('hex');
    this.counters.calls++;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.counters.cacheHits++;
      return this.finish<Q>(hit, started, true, 0);
    }
    const resolved = await this.resolve(req, gate, body);
    this.cache.set(key, resolved);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return this.finish<Q>(resolved, started, false, estimateTokens(body));
  }

  async noul(a: {
    state: Record<string, unknown>;
    question: string;
    criteria?: { true?: string; false?: string } | null;
    gate?: SystemOneGate;
  }): Promise<{
    value: boolean;
    noul: number;
    prob: number;
    model: string;
    backend: SystemOneBackendKind;
    latencyMs: number;
  }> {
    const r = await this.systemOne({
      state: a.state,
      questions: { q: noul(a.question, a.criteria) },
      ...(a.gate ? { gate: a.gate } : {}),
    });
    const ans = r.answers.q;
    return {
      value: ans.prob >= 0.5,
      noul: ans.noul,
      prob: ans.prob,
      model: r.model,
      backend: r.backend,
      latencyMs: r.latencyMs,
    };
  }

  async choice<K extends string>(a: {
    state: Record<string, unknown>;
    question: string;
    options: Record<K, string | null>;
    gate?: SystemOneGate;
  }): Promise<
    ChoiceAnswer<K> & { model: string; backend: SystemOneBackendKind; latencyMs: number }
  > {
    const r = await this.systemOne({
      state: a.state,
      questions: { q: choice(a.question, a.options) },
      ...(a.gate ? { gate: a.gate } : {}),
    });
    return { ...r.answers.q, model: r.model, backend: r.backend, latencyMs: r.latencyMs };
  }

  async score(a: {
    state: Record<string, unknown>;
    question: string;
    rubric: readonly string[];
    gate?: SystemOneGate;
  }): Promise<ScoreAnswer & { model: string; backend: SystemOneBackendKind; latencyMs: number }> {
    const r = await this.systemOne({
      state: a.state,
      questions: { q: score(a.question, a.rubric) },
      ...(a.gate ? { gate: a.gate } : {}),
    });
    return { ...r.answers.q, model: r.model, backend: r.backend, latencyMs: r.latencyMs };
  }

  private finish<Q extends Record<string, SystemOneQuestion>>(
    r: { model: string; answers: Record<string, AnyAnswer>; backend: SystemOneBackendKind },
    started: number,
    cached: boolean,
    inputTokens: number,
  ): SystemOneResponse<Q> {
    const latencyMs = Math.max(0, this.opts.now() - started);
    const usd =
      r.backend === 'jev-http' && r.model.startsWith('jev')
        ? inputTokens * JEV_USD_PER_INPUT_TOKEN
        : 0;
    this.counters.byBackend[r.backend]++;
    this.counters.inputTokens += inputTokens;
    this.counters.usd += usd;
    this.latencies.push(latencyMs);
    if (this.latencies.length > 200) this.latencies.shift();
    return {
      model: r.model,
      answers: r.answers as Answers<Q>,
      usage: { inputTokens, usd },
      backend: r.backend,
      latencyMs,
      cached,
    };
  }

  private async resolve(
    req: SystemOneRequest<Record<string, SystemOneQuestion>>,
    gate: SystemOneGate,
    body: string,
  ): Promise<{ model: string; answers: Record<string, AnyAnswer>; backend: SystemOneBackendKind }> {
    const local = () => ({
      model: 'calibrated-local',
      answers: localAnswers(gate, req.state, req.questions),
      backend: 'calibrated-local' as const,
    });
    const primary = this.primary;
    try {
      if (primary === 'jev-http') return await this.viaHttp(req);
      if (primary === 'ollama-s1') {
        const viaOllama = await this.viaOllama(req, body);
        if (viaOllama) return viaOllama;
        return local();
      }
    } catch {
      this.counters.fallbacks++;
    }
    return local();
  }

  private async viaHttp(
    req: SystemOneRequest<Record<string, SystemOneQuestion>>,
  ): Promise<{ model: string; answers: Record<string, AnyAnswer>; backend: 'jev-http' }> {
    const model = req.model ?? this.opts.model;
    const res = await this.opts.fetch(this.opts.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, state: req.state, questions: req.questions }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`system-1 HTTP ${String(res.status)}`);
    const json = (await res.json()) as { model?: unknown; answers?: unknown };
    return {
      model: typeof json.model === 'string' ? json.model : model,
      answers: this.normalizeAll(req.questions, json.answers),
      backend: 'jev-http',
    };
  }

  private normalizeAll(
    questions: Record<string, SystemOneQuestion>,
    raw: unknown,
  ): Record<string, AnyAnswer> {
    if (typeof raw !== 'object' || raw === null)
      throw new Error('system-1 response has no answers');
    const src = raw as Record<string, unknown>;
    const out: Record<string, AnyAnswer> = {};
    for (const [k, q] of Object.entries(questions)) {
      if (!(k in src)) throw new Error(`system-1 response is missing "${k}"`);
      out[k] = normalizeAnswer(q, src[k]);
    }
    return out;
  }

  /** Which Ollama model answers (kev:4b when installed), or undefined when Ollama is offline. */
  private async ollamaModel(): Promise<string | undefined> {
    if (this.opts.now() < this.ollamaOfflineUntil) return undefined;
    if (this.ollamaModelResolved) return this.ollamaModelResolved;
    try {
      const res = await this.opts.fetch(`${this.opts.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(OLLAMA_PROBE_MS),
      });
      const json = (await res.json()) as { models?: { name?: string }[] };
      const names = (json.models ?? []).map((m) => m.name ?? '');
      const pick = names.includes(OLLAMA_PREFERRED)
        ? OLLAMA_PREFERRED
        : names.find((n) => n === this.opts.ollamaModel || n.startsWith(this.opts.ollamaModel));
      if (!pick) throw new Error('no System-1 model installed in Ollama');
      this.ollamaModelResolved = pick;
      return pick;
    } catch {
      this.ollamaOfflineUntil = this.opts.now() + OLLAMA_OFFLINE_MS;
      return undefined;
    }
  }

  private async viaOllama(
    req: SystemOneRequest<Record<string, SystemOneQuestion>>,
    body: string,
  ): Promise<
    { model: string; answers: Record<string, AnyAnswer>; backend: 'ollama-s1' } | undefined
  > {
    const model = await this.ollamaModel();
    if (!model) return undefined;
    const n = Object.keys(req.questions).length;
    const res = await this.opts.fetch(`${this.opts.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: ollamaPrompt(body),
        format: 'json',
        stream: false,
        options: { temperature: 0, num_predict: Math.min(1024, Math.max(96, 48 * n)) },
      }),
      signal: AbortSignal.timeout(Math.max(this.opts.timeoutMs, 2_500)),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${String(res.status)}`);
    const json = (await res.json()) as { response?: unknown };
    const parsed = JSON.parse(typeof json.response === 'string' ? json.response : '{}') as {
      answers?: unknown;
    };
    return {
      model: `ollama:${model}`,
      answers: this.normalizeAll(req.questions, parsed.answers ?? parsed),
      backend: 'ollama-s1',
    };
  }
}

function ollamaPrompt(body: string): string {
  return [
    'You are a System-1 decision model. Answer every question about the state in one pass.',
    'For "noul" give {"noul": probability the statement is true, 0..1}.',
    'For "choice" give {"choice": one criteria key, "probabilities": {key: 0..1 for every key}}.',
    'For "score" give {"score": index of the best rubric level (0-based), "probabilities": {"0": p, ...}}.',
    'Reply with only JSON: {"answers": {"<question key>": {...}}}.',
    body,
  ].join('\n');
}
