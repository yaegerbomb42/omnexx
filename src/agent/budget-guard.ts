import type { ContentBlock, Message } from '../providers/types.js';
import { contextTokens } from './compaction.js';

/**
 * The last line of defence for the user's context budget: when pruning and folding still leave
 * the history over it (one huge tool result, a fold that failed), replace the largest blocks with
 * a digest until it fits. A digest keeps the head and tail lines and says how to get the rest
 * back (the bash log id, or the same call again). The first message (goal and working state) is
 * never touched. Pure: returns new messages.
 */

export const DIGEST_PREFIX = '[digest by omnexx:';
const DIGEST_LINES = 6;
const DIGEST_LINE_CHARS = 200;
/** Blocks shorter than this can't be shrunk meaningfully. */
const MIN_DIGEST_CHARS = 600;
const LOG_ID = /^\[[^\]\n]*\blog ([\w.-]+)\]/;

export function digest(content: string): string {
  const lines = content.split('\n');
  const clipLine = (l: string) =>
    l.length > DIGEST_LINE_CHARS ? `${l.slice(0, DIGEST_LINE_CHARS)}…` : l;
  const head = lines.slice(0, DIGEST_LINES).map(clipLine);
  const tail = lines.length > DIGEST_LINES * 2 ? lines.slice(-DIGEST_LINES).map(clipLine) : [];
  const log = LOG_ID.exec(content)?.[1];
  const back = log ? `read_log id="${log}" has it all` : 'repeat the call for the full output';
  return [
    `${DIGEST_PREFIX} ${content.length} chars, ${lines.length} lines; ${back}]`,
    ...head,
    ...(tail.length ? ['…', ...tail] : []),
  ].join('\n');
}

interface Spot {
  i: number;
  j: number;
  size: number;
}

/** Digestible blocks: older turns biggest first, then the newest turn's (from `newest` on). */
function spots(messages: readonly Message[], newest: number): Spot[] {
  const out: Spot[] = [];
  messages.forEach((m, i) => {
    if (i === 0) return;
    m.content.forEach((b, j) => {
      const size =
        b.type === 'tool_result' ? b.content.length : b.type === 'text' ? b.text.length : 0;
      const already =
        (b.type === 'tool_result' && b.content.startsWith(DIGEST_PREFIX)) ||
        (b.type === 'text' && b.text.startsWith(DIGEST_PREFIX));
      if (size >= MIN_DIGEST_CHARS && !already) out.push({ i, j, size });
    });
  });
  const older = out.filter((s) => s.i < newest).sort((a, b) => b.size - a.size);
  const recent = out.filter((s) => s.i >= newest).sort((a, b) => b.size - a.size);
  return [...older, ...recent];
}

function shrink(b: ContentBlock): ContentBlock {
  if (b.type === 'tool_result') return { ...b, content: digest(b.content) };
  if (b.type === 'text') return { ...b, text: digest(b.text) };
  return b;
}

export interface GuardOutcome {
  messages: Message[];
  digested: number;
  tokens: number;
}

/** Index of the newest turn: its last assistant message (the turn the model is acting on). */
export function newestTurnStart(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i > 0; i--) if (messages[i]?.role === 'assistant') return i;
  return messages.length;
}

/**
 * Digest the largest blocks, biggest first, until the history is at most `budget` tokens. With
 * `spareNewest`, the newest turn is left whole (used to settle after a fold, which is a soft
 * target); the hard cap digests older turns first, then the newest, never the first message.
 */
export function enforceBudget(
  messages: readonly Message[],
  budget: number,
  spareNewest = false,
): GuardOutcome {
  let tokens = contextTokens(messages);
  if (tokens <= budget) return { messages: [...messages], digested: 0, tokens };
  let current = [...messages];
  let digested = 0;
  const newest = newestTurnStart(messages);
  const order = spots(messages, newest).filter((s) => !spareNewest || s.i < newest);
  for (const s of order) {
    if (tokens <= budget) break;
    current = current.map((m, i) =>
      i === s.i ? { ...m, content: m.content.map((b, j) => (j === s.j ? shrink(b) : b)) } : m,
    );
    digested++;
    tokens = contextTokens(current);
  }
  return { messages: current, digested, tokens };
}
