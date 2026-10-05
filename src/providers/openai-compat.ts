import { ProviderError } from '../errors.js';
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
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

/** Map our provider-neutral conversation to Chat Completions messages. */
export function toChatMessages(req: CompletionRequest): ChatMessage[] {
  const out: ChatMessage[] = [
    { role: 'system', content: req.system.map((b) => b.text).join('\n\n') },
  ];
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
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result')
        out.push({
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.isError ? `ERROR: ${b.content}` : b.content,
        });
      else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
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
export class OpenAICompatProvider implements Provider {
  readonly name: string;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.name = opts.name;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: req.model,
      messages: toChatMessages(req),
      max_tokens: req.maxTokens,
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
    };
    const signals = [AbortSignal.timeout(this.opts.timeoutMs), ...(req.signal ? [req.signal] : [])];
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(
        `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        },
      );
    } catch (err) {
      if (req.signal?.aborted)
        throw new ProviderError('request aborted', { retryable: false, cause: err });
      throw new ProviderError(`network error talking to ${this.name}: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    let data: ChatResponse;
    try {
      data = (await res.json()) as ChatResponse;
    } catch (err) {
      throw new ProviderError(`${this.name} returned non-JSON (HTTP ${res.status})`, {
        retryable: res.status >= 500,
        status: res.status,
        cause: err,
      });
    }
    if (!res.ok) {
      const s = res.status;
      throw new ProviderError(
        `${this.name} error ${s}: ${data.error?.message ?? 'request failed'}`,
        {
          retryable: s === 408 || s === 409 || s === 429 || s >= 500,
          status: s,
          ...(s === 401 || s === 403 ? { hint: `check the key for ${this.name}` } : {}),
        },
      );
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
    const prompt = data.usage?.prompt_tokens ?? 0;
    const cached = Math.min(prompt, data.usage?.prompt_tokens_details?.cached_tokens ?? 0);
    return {
      model: data.model ?? req.model,
      stopReason: mapStop(
        choice?.finish_reason,
        content.some((b) => b.type === 'tool_use'),
      ),
      content,
      usage: {
        uncached: prompt - cached,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: cached,
        output: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
