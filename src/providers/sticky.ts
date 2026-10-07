import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProviderError } from '../errors.js';
import { discoverModels } from './discovery.js';
import type { CompletionRequest, CompletionResponse, Provider } from './types.js';

/** Model ids a pool serves that aren't chat models an agent can use. */
const NOT_CHAT =
  /embed|rerank|(^|-)mt-|tts|asr|whisper|speech|audio|omni|-vl|vl-|image|vision|tingwu|character|moderation|guard|ocr/i;
/** A quota mark expires after this long (quotas usually reset daily). */
const EXHAUSTED_FOR_MS = 24 * 3_600_000;
const MAX_SWITCHES = 6;

/** Whether an error means "this model has no quota left" (not a passing rate limit). */
export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  const quota =
    /quota|exhaust|insufficient|limit (exceeded|reached)|token limit|out of (credit|token)|billing|balance/i;
  return (
    ((err.status === 429 || err.status === 402 || err.status === 403) && quota.test(err.message)) ||
    (err.status === 400 && /quota|exhaust/i.test(err.message))
  );
}

interface StickyState {
  current: string | undefined;
  exhausted: Record<string, number>;
}

export interface StickyOptions {
  baseUrl: string;
  apiKey: string | undefined;
  /** Where the pick and the exhausted list survive restarts. */
  stateFile: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Deterministic order in tests. */
  shuffle?: <T>(xs: T[]) => T[];
}

const randomShuffle = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

/**
 * Wraps an endpoint so a `*-random` model id is replaced by one real model, kept until that model
 * reports it is out of quota; then the next one takes over. One model at a time keeps the prompt
 * cache warm, where the server's own random routing switches model on every request.
 */
export function withStickyRandom(inner: Provider, o: StickyOptions): Provider {
  const now = o.now ?? Date.now;
  let state: StickyState | undefined;
  let order: string[] | undefined;

  const load = async (): Promise<StickyState> => {
    if (state) return state;
    try {
      const raw = JSON.parse(await readFile(o.stateFile, 'utf8')) as Partial<StickyState>;
      state = { current: raw.current, exhausted: raw.exhausted ?? {} };
    } catch {
      state = { current: undefined, exhausted: {} };
    }
    return state;
  };
  const save = async (): Promise<void> => {
    await mkdir(dirname(o.stateFile), { recursive: true });
    await writeFile(o.stateFile, JSON.stringify(state, null, 2));
  };
  const pick = async (): Promise<string> => {
    const s = await load();
    s.exhausted = Object.fromEntries(
      Object.entries(s.exhausted).filter(([, at]) => now() - at <= EXHAUSTED_FOR_MS),
    );
    if (s.current && !s.exhausted[s.current]) return s.current;
    order ??= (o.shuffle ?? randomShuffle)(
      (
        await discoverModels(
          { baseUrl: o.baseUrl, ...(o.apiKey ? { apiKey: o.apiKey } : {}) },
          o.fetch ? { fetch: o.fetch } : {},
        )
      )
        .map((m) => m.id)
        .filter((id) => !/random/i.test(id) && !NOT_CHAT.test(id)),
    );
    const next = order.find((m) => !s.exhausted[m]);
    if (!next)
      throw new ProviderError(`every model on ${inner.name} is out of quota`, {
        retryable: true,
        status: 429,
      });
    s.current = next;
    await save();
    return next;
  };

  return {
    name: inner.name,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      if (!/(^|[-_])random$/i.test(req.model)) return inner.complete(req);
      for (let i = 0; ; i++) {
        const model = await pick();
        try {
          return await inner.complete({ ...req, model });
        } catch (err) {
          if (!isQuotaError(err) || i >= MAX_SWITCHES) throw err;
          const s = await load();
          s.exhausted[model] = now();
          s.current = undefined;
          await save();
        }
      }
    },
  };
}
