import { readFile } from 'node:fs/promises';
import { ProviderError } from '../errors.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  Usage,
} from './types.js';

/** One recorded model answer: what the model said, not the request it was answering. */
export interface RecordedTurn {
  text?: string;
  tools?: { name: string; input: unknown }[];
  /** Override the derived usage (e.g. a turn that is unusually long). */
  usage?: Partial<Usage>;
  stopReason?: CompletionResponse['stopReason'];
}

/** A recorded session: one entry per model call, in the order the calls happen. */
export interface RecordedSession {
  name: string;
  turns: RecordedTurn[];
}

/**
 * The recorded mock provider behind `npm run bench:efficiency`: answers come from a recorded
 * session fixture (test/fixtures/bench/providers), so a run is deterministic and needs no
 * network. Token usage is derived from the actual request (like the scripted provider), so a
 * change that bloats prompts shows up in the metrics; the real per-call latency is measured and
 * exposed for the p95 ratchet.
 */
export class RecordedProvider implements Provider {
  readonly name = 'recorded';
  private next = 0;
  private ids = 0;
  /** Observed wall-clock latency per call, in ms (for p95). */
  readonly latenciesMs: number[] = [];

  constructor(private readonly session: RecordedSession) {}

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    const turn = this.session.turns[this.next];
    if (!turn)
      throw new ProviderError(
        `recording '${this.session.name}' exhausted after ${String(this.next)} call(s); the agent made an unrecorded turn`,
        { retryable: false, status: 500 },
      );
    this.next++;
    const started = performance.now();
    const content: ContentBlock[] = [];
    if (turn.text) content.push({ type: 'text', text: turn.text });
    for (const call of turn.tools ?? [])
      content.push({
        type: 'tool_use',
        id: `tu_${++this.ids}`,
        name: call.name,
        input: call.input,
      });
    const size = Math.ceil(JSON.stringify(req.messages).length / 4) + 2_000;
    const usage: Usage = {
      uncached: this.next === 1 ? 300 : 120,
      cacheWrite5m: this.next === 1 ? size : Math.ceil(size * 0.1),
      cacheWrite1h: 0,
      cacheRead: this.next === 1 ? 0 : Math.ceil(size * 0.9),
      output: 200,
      ...turn.usage,
    };
    const response: CompletionResponse = {
      content,
      stopReason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage,
      model: req.model,
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    };
    this.latenciesMs.push(performance.now() - started);
    return Promise.resolve(response);
  }
}

/** Parse a JSONL session fixture: one JSON `RecordedTurn` per line, `#` comment lines allowed. */
export async function loadRecordedSession(path: string): Promise<RecordedSession> {
  const text = await readFile(path, 'utf-8');
  const turns: RecordedTurn[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    turns.push(JSON.parse(trimmed) as RecordedTurn);
  }
  return { name: path.split('/').at(-1) ?? 'recording', turns };
}
