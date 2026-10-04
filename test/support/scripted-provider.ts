import { ProviderError } from '../../src/errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  Usage,
} from '../../src/providers/types.js';

export interface ScriptMeta {
  /** Task id parsed from the cycle-state message ("Work on M1.T01"). */
  taskId: string | undefined;
  /** 1-based attempt number from the plan view ("Attempt: 2."). */
  attempt: number;
  /** 0-based index of this turn inside the conversation. */
  turn: number;
  planner: boolean;
  request: CompletionRequest;
}

export interface ScriptedTurn {
  text?: string;
  tools?: { name: string; input: unknown }[];
  usage?: Partial<Usage>;
  /** Throw this instead of answering (outage simulation). */
  error?: ProviderError;
}

export type Script = (meta: ScriptMeta) => ScriptedTurn;

const firstText = (req: CompletionRequest): string => {
  const b = req.messages[0]?.content[0];
  return b?.type === 'text' ? b.text : '';
};

/**
 * The backbone of the integration and chaos tests (plan §7.2): a Provider that answers from a
 * script keyed by task, attempt and turn. That makes replies a pure function of the request, so
 * a crash-and-resume replays the same way.
 */
export class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  readonly requests: CompletionRequest[] = [];
  private ids = 0;

  constructor(private readonly script: Script) {}

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const text = firstText(req);
    const meta: ScriptMeta = {
      taskId: /Work on (M\d+\.T\d+)/.exec(text)?.[1],
      attempt: Number(/Attempt: (\d+)\./.exec(text)?.[1] ?? 1),
      turn: req.messages.filter((m) => m.role === 'assistant').length,
      planner: req.system.some((b) => b.text.includes('You are the planner')),
      request: req,
    };
    const t = this.script(meta);
    if (t.error) return Promise.reject(t.error);
    const content: ContentBlock[] = [];
    if (t.text) content.push({ type: 'text', text: t.text });
    for (const call of t.tools ?? [])
      content.push({
        type: 'tool_use',
        id: `tu_${++this.ids}`,
        name: call.name,
        input: call.input,
      });
    // Synthetic usage that looks like a cached conversation: the prefix is read from cache after turn 0.
    const size = Math.ceil(JSON.stringify(req.messages).length / 4) + 2_000;
    const usage: Usage = {
      uncached: meta.turn === 0 ? 300 : 120,
      cacheWrite5m: meta.turn === 0 ? size : Math.ceil(size * 0.1),
      cacheWrite1h: 0,
      cacheRead: meta.turn === 0 ? 0 : Math.ceil(size * 0.9),
      output: 200,
      ...t.usage,
    };
    return Promise.resolve({
      content,
      stopReason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage,
      model: req.model,
    });
  }
}

/** Common building blocks for scripts. */
export const say = (text: string): ScriptedTurn => ({ text });
export const call = (name: string, input: unknown, text?: string): ScriptedTurn => ({
  ...(text ? { text } : {}),
  tools: [{ name, input }],
});
export const outage = (): ScriptedTurn => ({
  error: new ProviderError('529 overloaded (simulated)', { retryable: true, status: 529 }),
});
