/** Provider-neutral conversation types. The agent loop and the context builder only see these. */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** An image the person attached (base64, no data: prefix). */
  | { type: 'image'; mediaType: ImageMediaType; data: string }
  /** Provider-specific blocks (e.g. thinking with signatures) that must be sent back verbatim. */
  | { type: 'opaque'; provider: string; block: unknown };

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface SystemBlock {
  text: string;
  /** Put a cache breakpoint after this block. */
  cacheBreakpoint?: boolean;
  /**
   * Changes every turn (the clock block: elapsed time, budget left, pace). Blocks
   * that change rarely — goal, notes, codemap — are NOT volatile: a change costs
   * one turn's cache miss from that block onward, then the new prefix re-caches.
   * Marking them volatile would reprocess them on every turn instead. Chat
   * Completions templates render tools after the system message, so a provider
   * without explicit breakpoints moves these blocks into the first user message
   * to keep system + tools a byte-stable cached prefix.
   */
  volatile?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  /** Concrete model id, already resolved from the role alias. */
  model: string;
  system: SystemBlock[];
  tools: ToolSpec[];
  messages: Message[];
  maxTokens: number;
  /** Indices into `messages` whose last block gets a cache breakpoint. */
  messageBreakpoints: number[];
  /** `none` keeps the tools in the request (and its cached prefix) but forbids calling them. */
  toolChoice?: { type: 'auto' } | { type: 'none' } | { type: 'tool'; name: string };
  /** Which configured provider serves this call (default "anthropic"). */
  route?: string;
  signal?: AbortSignal;
  /**
   * Thinking depth for this call, 1-10 ([agent] turn_effort); each provider maps it to its own
   * knob (reasoning_effort, a thinking budget). Unset: the provider's default.
   */
  turnEffort?: number;
  /** Stream text and reasoning as they arrive (interactive chat); the result is the same. */
  onDelta?: (d: { text?: string; reasoning?: string }) => void;
  /** OpenAI prompt-cache routing key, stable for one run. Omitted by providers that reject it. */
  promptCacheKey?: string;
  /**
   * A per-run key OpenAI-compatible endpoints use to route every call of a conversation to the
   * same prompt-cache backend. Endpoints that reject the field are answered plainly after one 400.
   */
  cacheKey?: string;
}

export interface Usage {
  /** Input tokens billed at the base rate (not read from or written to cache). */
  uncached: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export type StopReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
  /** The model's visible reasoning, when the provider returns it (shown, never sent back). */
  reasoning?: string;
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export const emptyUsage = (): Usage => ({
  uncached: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
});

const nonNeg = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);

export const totalInput = (u: Usage): number =>
  nonNeg(u.uncached) + nonNeg(u.cacheWrite5m) + nonNeg(u.cacheWrite1h) + nonNeg(u.cacheRead);

/** Cache reads cost about a tenth of fresh input on every major provider. */
const CACHE_READ_WEIGHT = 0.1;

/**
 * Tokens as they count against a cycle's token cap: what they cost, so a long, mostly cached
 * session isn't stopped early (a 82k-fresh session once hit the 400k cap on cache reads alone).
 */
export const budgetTokens = (u: Usage): number =>
  nonNeg(u.uncached) +
  nonNeg(u.cacheWrite5m) +
  nonNeg(u.cacheWrite1h) +
  nonNeg(u.output) +
  Math.ceil(nonNeg(u.cacheRead) * CACHE_READ_WEIGHT);
