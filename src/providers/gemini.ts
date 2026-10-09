import { ProviderError } from '../errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  StopReason,
} from './types.js';

export interface GeminiOptions {
  apiKey: string | undefined;
  /** e.g. https://generativelanguage.googleapis.com (tests inject a loopback URL). */
  baseUrl?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  inlineData?: { mimeType: string; data: string };
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

function toContents(req: CompletionRequest): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use')
          parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
      }
      if (parts.length) out.push({ role: 'model', parts });
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result')
        parts.push({
          functionResponse: { name: b.toolUseId, response: { result: b.content } },
        });
      else if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image')
        parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
    }
    if (parts.length) out.push({ role: 'user', parts });
  }
  return out;
}

function mapStop(r: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls || r === 'TOOL_CALL' || r === 'FUNCTION_CALL') return 'tool_use';
  if (r === 'STOP') return 'end_turn';
  if (r === 'MAX_TOKENS') return 'max_tokens';
  if (r === 'SAFETY' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT') return 'refusal';
  return 'other';
}

/**
 * Native Gemini provider: `generateContent` with function calling and usage
 * metadata. Plain `fetch`, no SDK. Implements the Provider interface in types.ts.
 */
export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  constructor(private readonly opts: GeminiOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const base = (this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );
    const tools = req.tools.length
      ? [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      : [];
    const body = {
      system_instruction: req.system.length
        ? { parts: req.system.map((b) => ({ text: b.text })) }
        : undefined,
      contents: toContents(req),
      tools: tools.length ? tools : undefined,
      generationConfig: { maxOutputTokens: req.maxTokens },
    };
    const signals = [AbortSignal.timeout(this.opts.timeoutMs), ...(req.signal ? [req.signal] : [])];
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { 'x-goog-api-key': this.opts.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (req.signal?.aborted)
        throw new ProviderError('request aborted', { retryable: false, cause: err });
      throw new ProviderError(`network error talking to gemini: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    let data: GeminiResponse;
    try {
      data = (await res.json()) as GeminiResponse;
    } catch (err) {
      throw new ProviderError(`gemini returned non-JSON (HTTP ${res.status})`, {
        retryable: res.status >= 500,
        status: res.status,
        cause: err,
      });
    }
    if (!res.ok) {
      const s = res.status;
      throw new ProviderError(`gemini error ${s}: ${data.error?.message ?? 'request failed'}`, {
        retryable: s === 408 || s === 409 || s === 429 || s >= 500,
        status: s,
        ...(s === 401 || s === 403 ? { hint: 'check the key for gemini' } : {}),
      });
    }
    const cand = data.candidates?.[0];
    const content: ContentBlock[] = [];
    let call = 0;
    for (const p of cand?.content?.parts ?? []) {
      if (typeof p.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
      if (p.functionCall)
        content.push({
          type: 'tool_use',
          id: `call_${call++}`,
          name: p.functionCall.name ?? '',
          input: p.functionCall.args ?? {},
        });
    }
    return {
      model: req.model,
      stopReason: mapStop(
        cand?.finishReason,
        content.some((b) => b.type === 'tool_use'),
      ),
      content,
      usage: {
        uncached: data.usageMetadata?.promptTokenCount ?? 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
