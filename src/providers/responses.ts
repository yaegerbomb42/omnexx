import { ProviderError } from '../errors.js';
import type { CompletionRequest, CompletionResponse, ContentBlock, Provider, StopReason } from './types.js';

export interface ResponsesOptions {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
}

interface ResponsesOutputItem {
  type?: string;
  text?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  id?: string;
}
interface ResponsesBody {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function toInput(req: CompletionRequest): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];
  if (req.system.length)
    out.push({ role: 'system', content: req.system.map((b) => b.text).join('\n\n') });
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'text') out.push({ role: 'assistant', content: b.text });
        else if (b.type === 'tool_use')
          out.push({ role: 'assistant', content: [{ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }] });
      }
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'tool_result')
        out.push({ role: 'user', content: [{ type: 'function_call_output', call_id: b.toolUseId, output: b.content }] });
      else if (b.type === 'text') out.push({ role: 'user', content: b.text });
    }
  }
  return out;
}

function mapStop(status: string | undefined, reason: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool_use';
  if (status === 'completed') return 'end_turn';
  if (reason === 'max_output_tokens') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'other';
}

/**
 * OpenAI Responses API provider (`kind = "responses"` endpoint). One POST to
 * `{base_url}/responses` with input items, tools as function tools, and usage
 * mapped to uncached/output. Implements the Provider interface in types.ts.
 */
export class ResponsesProvider implements Provider {
  readonly name: string;
  constructor(private readonly opts: ResponsesOptions) {
    this.name = opts.name;
  }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: req.model,
      input: toInput(req),
      max_output_tokens: req.maxTokens,
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema })) }
        : {}),
    };
    const signals = [AbortSignal.timeout(this.opts.timeoutMs), ...(req.signal ? [req.signal] : [])];
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(
        `${this.opts.baseUrl.replace(/\/+$/, '')}/responses`,
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
      if (req.signal?.aborted) throw new ProviderError('request aborted', { retryable: false, cause: err });
      throw new ProviderError(`network error talking to ${this.name}: ${(err as Error).message}`, { retryable: true, cause: err });
    }
    let data: ResponsesBody;
    try {
      data = (await res.json()) as ResponsesBody;
    } catch (err) {
      throw new ProviderError(`${this.name} returned non-JSON (HTTP ${res.status})`, { retryable: res.status >= 500, status: res.status, cause: err });
    }
    if (!res.ok) {
      const s = res.status;
      throw new ProviderError(`${this.name} error ${s}: ${data.error?.message ?? 'request failed'}`, {
        retryable: s === 408 || s === 409 || s === 429 || s >= 500,
        status: s,
        ...(s === 401 || s === 403 ? { hint: `check the key for ${this.name}` } : {}),
      });
    }
    const content: ContentBlock[] = [];
    for (const item of data.output ?? []) {
      if (item.type === 'function_call') {
        let input: unknown;
        try {
          input = JSON.parse(item.arguments === undefined || item.arguments === '' ? '{}' : item.arguments);
        } catch {
          input = { _unparseable_arguments: item.arguments ?? '' };
        }
        content.push({ type: 'tool_use', id: item.call_id ?? item.id ?? 'call_0', name: item.name ?? '', input });
      } else if (typeof item.text === 'string' && item.text) {
        content.push({ type: 'text', text: item.text });
      }
    }
    return {
      model: data.model ?? req.model,
      stopReason: mapStop(data.status, data.incomplete_details?.reason, content.some((b) => b.type === 'tool_use')),
      content,
      usage: {
        uncached: data.usage?.input_tokens ?? 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: data.usage?.output_tokens ?? 0,
      },
    };
  }
}
