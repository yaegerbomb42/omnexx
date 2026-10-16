import { ProviderError } from '../errors.js';
import { authHeaders, type EndpointAuth } from './auth-headers.js';
import { openaiReasoning } from './turn-effort.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  StopReason,
} from './types.js';

export interface OpenAICompatOptions {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** How the key is sent; unset is a bearer token. */
  auth?: EndpointAuth | undefined;
  /** Extra headers on every request. */
  headers?: Readonly<Record<string, string>> | undefined;
  /**
   * With this set, every request streams and is cut (retryably) when no bytes arrive for this
   * long, before the headers or between chunks: a hung call fails in minutes, not after
   * `timeoutMs`. Unset: only requests with `onDelta` stream, and only `timeoutMs` applies.
   */
  stallTimeoutMs?: number | undefined;
}

/** Arms on creation; `touch` restarts the window; `fired` says whether it cut the request. */
function stallWatch(ms: number): {
  signal: AbortSignal;
  touch: () => void;
  stop: () => void;
  fired: () => boolean;
} {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const span = ms < 1_000 ? `${String(ms)}ms` : `${String(Math.round(ms / 1_000))}s`;
      ctl.abort(new Error(`no data for ${span}`));
    }, ms);
  };
  arm();
  return {
    signal: ctl.signal,
    touch: () => {
      if (!ctl.signal.aborted) arm();
    },
    stop: () => {
      clearTimeout(timer);
    },
    fired: () => ctl.signal.aborted,
  };
}

type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: string | number; type?: string };
  detail?: unknown;
}

/** Map our provider-neutral conversation to Chat Completions messages. */
export function toChatMessages(req: CompletionRequest): ChatMessage[] {
  const stable = req.system.filter((b) => !b.volatile).map((b) => b.text);
  let carried = req.system.filter((b) => b.volatile).map((b) => b.text);
  const out: ChatMessage[] = [{ role: 'system', content: stable.join('\n\n') }];
  if (carried.length && !req.messages.some((m) => m.role === 'user'))
    out.push({ role: 'user', content: carried.join('\n\n') });
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      out.push({
        role: 'assistant',
        // A string even when the turn only calls tools: Ollama rejects null content.
        content: text,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const texts: string[] = [...carried];
    carried = [];
    const images: ChatPart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result')
        out.push({
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.isError ? `ERROR: ${b.content}` : b.content,
        });
      else if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image')
        images.push({
          type: 'image_url',
          image_url: { url: `data:${b.mediaType};base64,${b.data}` },
        });
    }
    if (images.length)
      out.push({ role: 'user', content: [{ type: 'text', text: texts.join('\n\n') }, ...images] });
    else if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  }
  return out;
}

function mapStop(r: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls || r === 'tool_calls') return 'tool_use';
  if (r === 'stop') return 'end_turn';
  if (r === 'length') return 'max_tokens';
  if (r === 'content_filter') return 'refusal';
  return 'other';
}

/**
 * One adapter for every OpenAI-compatible Chat Completions endpoint: OpenAI, OpenRouter, a
 * LiteLLM proxy, Ollama, vLLM. Plain `fetch`, no SDK. Caching is whatever the endpoint does on
 * its own; reported cached prompt tokens are billed at the cache-read rate.
 */
/** "Range of max_tokens should be [1, 8192]", "max_tokens must be less than or equal to 8192"… */
const MAX_TOKENS_LIMIT =
  /max_(?:completion_)?tokens\D{0,60}?(?:\[\s*1\s*,\s*|less than or equal to\s*|at most\s*|<=\s*|maximum(?: value)?(?: is| of)?\s*)(\d{3,7})/i;

/** The model's output limit when a 400 says the requested max_tokens was too high. */
export function maxTokensLimit(message: string): number | undefined {
  const m = MAX_TOKENS_LIMIT.exec(message);
  return m?.[1] ? Number(m[1]) : undefined;
}

/** A provider-side content filter refused the request (another model may accept it). */
const CONTENT_FILTER =
  /data_inspection_failed|content[_ ](?:filter|policy|management)|inappropriate content|safety (?:system|filter)/i;

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  /** Output limits learned from 400s, per model: later calls ask for no more than this. */
  private readonly outputCaps = new Map<string, number>();
  /** Models that want `max_completion_tokens` instead of `max_tokens` (OpenAI reasoning models). */
  private readonly completionTokens = new Set<string>();
  /** Off once the server refused `parallel_tool_calls` (some local servers reject unknown fields). */
  private parallelToolCalls = true;
  /**
   * Stream requests that didn't ask to, so stalls show (see `stallTimeoutMs`). Off once the
   * server refuses a stream, answers one with plain JSON, or leaves usage out of it.
   */
  private streamForStall = true;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.name = opts.name;
  }

  /**
   * Thinking switches differ per model, and a pool can route each request to a different one:
   * some refuse non-streaming calls unless `enable_thinking: false` is sent, thinking-only models
   * refuse that same flag. So a 400 about `enable_thinking` flips the flag for this request and
   * tries again (at most twice). A 400 saying max_tokens is above the model's limit records that
   * limit for the model and retries at it.
   */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let thinking: boolean | undefined;
    let sendEffort = true;
    for (let i = 0; ; i++) {
      try {
        const cap = this.outputCaps.get(req.model);
        return await this.attempt(
          cap && cap < req.maxTokens ? { ...req, maxTokens: cap } : req,
          thinking,
          sendEffort,
        );
      } catch (err) {
        if (i >= 3 || !(err instanceof ProviderError) || err.status !== 400) throw err;
        const limit = maxTokensLimit(err.message);
        if (limit && limit < (this.outputCaps.get(req.model) ?? req.maxTokens)) {
          this.outputCaps.set(req.model, limit);
          continue;
        }
        if (/max_completion_tokens/i.test(err.message) && !this.completionTokens.has(req.model)) {
          this.completionTokens.add(req.model);
          continue;
        }
        if (this.parallelToolCalls && /parallel_tool_calls/i.test(err.message)) {
          this.parallelToolCalls = false;
          continue;
        }
        if (!req.onDelta && this.streamsForStall() && /stream/i.test(err.message)) {
          this.streamForStall = false;
          continue;
        }
        // A model without reasoning knobs: drop the turn effort and send the plain request.
        if (sendEffort && req.turnEffort !== undefined && /reasoning/i.test(err.message)) {
          sendEffort = false;
          continue;
        }
        if (!/enable_thinking/i.test(err.message)) throw err;
        thinking = thinking === false ? undefined : false;
      }
    }
  }

  private streamsForStall(): boolean {
    return this.streamForStall && (this.opts.stallTimeoutMs ?? 0) > 0;
  }

  private async attempt(
    req: CompletionRequest,
    thinking: boolean | undefined,
    sendEffort = true,
  ): Promise<CompletionResponse> {
    const forStall = !req.onDelta && this.streamsForStall();
    const stall = req.onDelta || forStall ? stallWatchFor(this.opts.stallTimeoutMs) : undefined;
    try {
      return await this.request(req, thinking, sendEffort, Boolean(req.onDelta) || forStall, stall);
    } finally {
      stall?.stop();
    }
  }

  private async request(
    req: CompletionRequest,
    thinking: boolean | undefined,
    sendEffort: boolean,
    stream: boolean,
    stall: ReturnType<typeof stallWatch> | undefined,
  ): Promise<CompletionResponse> {
    const effort = sendEffort ? openaiReasoning(req) : undefined;
    const body = {
      model: req.model,
      messages: toChatMessages(req),
      ...(this.completionTokens.has(req.model)
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens }),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(req.toolChoice?.type === 'tool'
        ? { tool_choice: { type: 'function', function: { name: req.toolChoice.name } } }
        : {}),
      // Several independent calls in one turn save whole round trips; the loop runs reads at once.
      ...(req.tools.length && !req.toolChoice && this.parallelToolCalls
        ? { parallel_tool_calls: true }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(thinking === undefined ? {} : { enable_thinking: thinking }),
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    const signals = [
      AbortSignal.timeout(this.opts.timeoutMs),
      ...(req.signal ? [req.signal] : []),
      ...(stall ? [stall.signal] : []),
    ];
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(
        `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(this.opts.apiKey, this.opts.auth, this.opts.headers),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        },
      );
    } catch (err) {
      if (req.signal?.aborted)
        throw new ProviderError('request aborted', { retryable: false, cause: err });
      if (stall?.fired()) throw this.stalled(stall, 'before responding', err);
      throw new ProviderError(`network error talking to ${this.name}: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    stall?.touch();
    const sse = stream && res.ok && res.body && !isJson(res);
    if (stream && !req.onDelta && res.ok && !sse) this.streamForStall = false;
    let data: ChatResponse;
    try {
      data =
        sse && res.body
          ? await readStream(res.body, req.onDelta ?? noDelta, () => stall?.touch())
          : ((await res.json()) as ChatResponse);
    } catch (err) {
      if (req.signal?.aborted)
        throw new ProviderError('request aborted', { retryable: false, cause: err });
      if (stall?.fired()) throw this.stalled(stall, 'mid-answer', err);
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`${this.name} returned non-JSON (HTTP ${res.status})`, {
        retryable: res.status >= 500,
        status: res.status,
        cause: err,
      });
    }
    if (!res.ok) {
      const s = res.status;
      // OpenAI shape, or FastAPI-style proxies: { "detail": "…" }.
      const message = data.error?.message ?? (typeof data.detail === 'string' ? data.detail : '');
      if (CONTENT_FILTER.test(`${message} ${String(data.error?.code ?? '')}`))
        throw new ProviderError(`${this.name} content filter refused the request: ${message}`, {
          retryable: false,
          status: s,
          contentFilter: true,
        });
      throw new ProviderError(`${this.name} error ${s}: ${message || 'request failed'}`, {
        retryable: s === 408 || s === 409 || s === 429 || s >= 500,
        status: s,
        ...(s === 401 || s === 403 ? { hint: `check the key for ${this.name}` } : {}),
      });
    }
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const content: ContentBlock[] = [];
    if (msg?.content) content.push({ type: 'text', text: msg.content });
    for (const [i, c] of (msg?.tool_calls ?? []).entries()) {
      const raw = c.function?.arguments;
      let input: unknown;
      try {
        // An empty arguments string means "no arguments".
        input = JSON.parse(raw === undefined || raw === '' ? '{}' : raw);
      } catch {
        input = { _unparseable_arguments: c.function?.arguments ?? '' };
      }
      content.push({
        type: 'tool_use',
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? '',
        input,
      });
    }
    const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? undefined;
    // Without usage the run can't meter itself: later calls go back to plain requests.
    if (sse && !req.onDelta && !data.usage) this.streamForStall = false;
    const prompt = data.usage?.prompt_tokens ?? 0;
    const cached = Math.min(prompt, data.usage?.prompt_tokens_details?.cached_tokens ?? 0);
    return {
      model: data.model ?? req.model,
      stopReason: mapStop(
        choice?.finish_reason,
        content.some((b) => b.type === 'tool_use'),
      ),
      content,
      ...(reasoning ? { reasoning } : {}),
      usage: {
        uncached: prompt - cached,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: cached,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  private stalled(stall: { signal: AbortSignal }, when: string, cause: unknown): ProviderError {
    const why = stall.signal.reason instanceof Error ? stall.signal.reason.message : 'no data';
    return new ProviderError(`${this.name} stalled ${when}: ${why}`, { retryable: true, cause });
  }
}

const noDelta = (): void => undefined;

function stallWatchFor(ms: number | undefined): ReturnType<typeof stallWatch> | undefined {
  return ms && ms > 0 ? stallWatch(ms) : undefined;
}

function isJson(res: Response): boolean {
  return /application\/json/i.test(res.headers.get('content-type') ?? '');
}

interface StreamChunk {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: ChatResponse['usage'];
  error?: { message?: string; code?: string | number; type?: string };
}

/**
 * Assemble a server-sent-events Chat Completions stream into the shape the non-streaming
 * response has, calling `onDelta` for every piece of text and reasoning as it arrives.
 */
function streamErrorStatus(e: { code?: string | number; type?: string }): number {
  const code = Number(e.code);
  if (Number.isInteger(code) && code >= 400 && code < 600) return code;
  if (/invalid_request|invalid_parameter/i.test(`${e.type ?? ''} ${e.code ?? ''}`)) return 400;
  return 502;
}

/** An error sent inside a 200 stream (proxies and pools do this): typed like an HTTP one. */
function streamError(e: {
  message?: string;
  code?: string | number;
  type?: string;
}): ProviderError {
  const message = e.message ?? 'stream error';
  const status = streamErrorStatus(e);
  const contentFilter = CONTENT_FILTER.test(`${message} ${e.code ?? ''}`);
  return new ProviderError(`stream error: ${message}`, {
    retryable: !contentFilter && (status === 429 || status >= 500),
    status,
    contentFilter,
  });
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta: NonNullable<CompletionRequest['onDelta']>,
  onChunk: () => void = noDelta,
): Promise<ChatResponse> {
  let text = '';
  let reasoning = '';
  let finish: string | undefined;
  let model: string | undefined;
  let usage: ChatResponse['usage'];
  const calls: { id?: string; name: string; args: string }[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    onChunk();
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let c: StreamChunk;
      try {
        c = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }
      if (c.error) throw streamError(c.error);
      model ??= c.model;
      if (c.usage) usage = c.usage;
      const choice = c.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta;
      if (!d) continue;
      const r = d.reasoning ?? d.reasoning_content;
      if (r) {
        reasoning += r;
        onDelta({ reasoning: r });
      }
      if (d.content) {
        text += d.content;
        onDelta({ text: d.content });
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        const call = (calls[i] ??= { name: '', args: '' });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    choices: [
      {
        ...(finish ? { finish_reason: finish } : {}),
        message: {
          content: text || null,
          ...(reasoning ? { reasoning } : {}),
          tool_calls: calls.map((c) => ({
            ...(c.id ? { id: c.id } : {}),
            function: { name: c.name, arguments: c.args },
          })),
        },
      },
    ],
  };
}
