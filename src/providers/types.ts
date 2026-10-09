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
  toolChoice?: { type: 'auto' } | { type: 'tool'; name: string };
  /** Which configured provider serves this call (default "anthropic"). */
  route?: string;
  signal?: AbortSignal;
  /** Stream text and reasoning as they arrive (interactive chat); the result is the same. */
  onDelta?: (d: { text?: string; reasoning?: string }) => void;
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

export const totalInput = (u: Usage): number =>
  u.uncached + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
