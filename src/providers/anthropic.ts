import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { ProviderError } from '../errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  StopReason,
} from './types.js';

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  cacheTtl: '5m' | '1h';
  /** TTL for system-prompt breakpoints; defaults to cacheTtl. Never shorter than cacheTtl. */
  prefixTtl?: '5m' | '1h';
  timeoutMs: number;
  /** Injectable for tests (a loopback mock); defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Messages API with prompt caching. Order on the wire is tools → system → messages; the stable
 * prefix (tools + system) ends with a breakpoint, the cycle-state message has one, and the
 * latest message has a moving one so each turn reads the previous turn from cache (plan §4.1).
 * Retries are disabled here: the harness's own backoff (retry.ts) owns waiting.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: 0,
      timeout: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  buildParams(req: CompletionRequest): MessageCreateParamsNonStreaming {
    const cache = { type: 'ephemeral' as const, ttl: this.opts.cacheTtl };
    // Longer TTLs must come before shorter ones; the prefix always precedes the messages.
    const prefixTtl = this.opts.cacheTtl === '1h' ? '1h' : (this.opts.prefixTtl ?? '5m');
    const prefixCache = { type: 'ephemeral' as const, ttl: prefixTtl };
    const system: TextBlockParam[] = req.system.map((b) => ({
      type: 'text',
      text: b.text,
      ...(b.cacheBreakpoint ? { cache_control: prefixCache } : {}),
    }));
    const tools: Tool[] = [...req.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Tool['input_schema'],
      }));
    const breakpoints = new Set(req.messageBreakpoints);
    const messages: MessageParam[] = req.messages.map((m, i) => {
      const content = m.content.map((b) => toParam(b));
      const last = content.at(-1);
      if (
        breakpoints.has(i) &&
        last &&
        last.type !== 'thinking' &&
        last.type !== 'redacted_thinking'
      ) {
        Object.assign(last, { cache_control: cache });
      }
      return { role: m.role, content };
    });
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      tools,
      messages,
      ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let res: Anthropic.Message;
    try {
      const opts = req.signal ? { signal: req.signal } : {};
      if (req.onDelta) {
        const onDelta = req.onDelta;
        const stream = this.client.messages.stream(this.buildParams(req), opts);
        stream.on('text', (text) => {
          onDelta({ text });
        });
        res = await stream.finalMessage();
      } else res = await this.client.messages.create(this.buildParams(req), opts);
    } catch (err) {
      throw toProviderError(err);
    }
    const u = res.usage;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const writeTotal = u.cache_creation_input_tokens ?? 0;
    return {
      model: res.model,
      stopReason: mapStop(res.stop_reason),
      content: res.content.map((b): ContentBlock => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use')
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        return { type: 'opaque', provider: 'anthropic', block: b };
      }),
      usage: {
        uncached: u.input_tokens,
        cacheWrite5m: Math.max(0, writeTotal - write1h),
        cacheWrite1h: write1h,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens,
      },
    };
  }
}

function toParam(b: ContentBlock): ContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
    case 'opaque':
      return b.block as ContentBlockParam;
  }
}

function mapStop(r: string | null): StopReason {
  switch (r) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'refusal':
      return r;
    default:
      return 'other';
  }
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`network error talking to the Anthropic API: ${err.message}`, {
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const status: number | undefined = (err as { status?: number }).status;
    const retryable =
      status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    const hint =
      status === 401 || status === 403
        ? 'check the key with `omnexx doctor`; set it with `omnexx auth set anthropic`'
        : status === 400
          ? 'the request was rejected; see events.jsonl for details'
          : undefined;
    return new ProviderError(`Anthropic API error${status ? ` ${status}` : ''}: ${err.message}`, {
      retryable,
      ...(status !== undefined ? { status } : {}),
      ...(hint ? { hint } : {}),
      cause: err,
    });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new ProviderError('request aborted', { retryable: false, cause: err });
  }
  return new ProviderError(err instanceof Error ? err.message : String(err), {
    retryable: false,
    cause: err,
  });
}
