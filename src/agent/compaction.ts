import { z } from 'zod';
import { estimateTokens } from '../core/tokens.js';
import type { ContentBlock, Message } from '../providers/types.js';

/**
 * In-cycle context control (plan §3.6), provider-neutral so it works on every endpoint:
 * 1. past `clearAt` tokens, old large tool results are elided (free, deterministic);
 * 2. past `compactAt`, the older turns are summarized by the cheap model into a CycleSummary and
 *    folded into the first message, keeping the most recent turns verbatim.
 * The per-cycle token cap still ends a cycle that outgrows both.
 */
export interface CompactionSettings {
  clearAt: number;
  keepToolResults: number;
  compactAt: number;
  keepTurns: number;
}

/** Tool results shorter than this are never worth clearing. */
const MIN_CLEAR_CHARS = 1_000;
const CLEARED_PREFIX = '[cleared by omnexx:';
const MIN_TURNS_TO_COMPACT = 2;

export const cycleSummarySchema = z.object({
  done: z.array(z.string().max(300)).max(30),
  inProgress: z.string().max(600),
  filesTouched: z.array(z.string().max(200)).max(60),
  lastError: z.string().max(1_000).optional(),
  nextStep: z.string().max(600),
});
export type CycleSummary = z.infer<typeof cycleSummarySchema>;

export function contextTokens(messages: readonly Message[]): number {
  return estimateTokens(JSON.stringify(messages));
}

/**
 * Replace the content of all but the newest `keep` tool results that are large, with a note that
 * tells the model how to get the data back. Returns new messages; the input is not mutated.
 */
export function clearOldToolResults(
  messages: readonly Message[],
  keep: number,
): { messages: Message[]; cleared: number; chars: number } {
  const positions: [number, number][] = [];
  messages.forEach((m, i) => {
    m.content.forEach((b, j) => {
      if (b.type === 'tool_result') positions.push([i, j]);
    });
  });
  const old = new Set(positions.slice(0, Math.max(0, positions.length - keep)).map(String));
  let cleared = 0;
  let chars = 0;
  const out = messages.map((m, i) => {
    if (!m.content.some((_, j) => old.has(String([i, j])))) return m;
    const content = m.content.map((b, j): ContentBlock => {
      if (b.type !== 'tool_result' || !old.has(String([i, j]))) return b;
      if (b.content.length < MIN_CLEAR_CHARS || b.content.startsWith(CLEARED_PREFIX)) return b;
      cleared++;
      chars += b.content.length;
      return {
        ...b,
        content: `${CLEARED_PREFIX} ${b.content.length} chars of old tool output; run the tool again if you still need it]`,
      };
    });
    return { ...m, content };
  });
  return { messages: out, cleared, chars };
}

/**
 * Split after the first message into the part to summarize and the recent tail to keep. The tail
 * starts at an assistant message so every tool_use keeps its tool_result. Undefined when fewer
 * than two turns are old enough to summarize.
 */
export function splitForCompaction(
  messages: readonly Message[],
  keepTurns: number,
): { head: Message[]; tail: Message[] } | undefined {
  const assistants = messages.flatMap((m, i) => (m.role === 'assistant' && i > 0 ? [i] : []));
  const cut = assistants[assistants.length - keepTurns];
  // At least two old turns, so a compaction is never redone on the very next turn.
  if (cut === undefined || assistants.indexOf(cut) < MIN_TURNS_TO_COMPACT) return undefined;
  return { head: messages.slice(1, cut), tail: messages.slice(cut) };
}

/** Plain-text transcript of the turns being summarized, each block capped so the input stays bounded. */
export function transcriptFor(messages: readonly Message[], maxBlockChars = 2_000): string {
  const cap = (s: string) =>
    s.length > maxBlockChars ? `${s.slice(0, maxBlockChars)}… [${s.length} chars]` : s;
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`${m.role}: ${cap(b.text)}`);
      else if (b.type === 'tool_use')
        lines.push(`tool call ${b.name}: ${cap(JSON.stringify(b.input))}`);
      else if (b.type === 'tool_result')
        lines.push(`tool result${b.isError ? ' (error)' : ''}: ${cap(b.content)}`);
    }
  }
  return lines.join('\n');
}

export function renderSummary(s: CycleSummary): string {
  const parts = ['# Earlier in this cycle (compacted summary)'];
  if (s.done.length) parts.push(`Done:\n${s.done.map((d) => `- ${d}`).join('\n')}`);
  parts.push(`In progress: ${s.inProgress}`);
  if (s.filesTouched.length) parts.push(`Files touched: ${s.filesTouched.join(', ')}`);
  if (s.lastError) parts.push(`Last error: ${s.lastError}`);
  parts.push(`Next step: ${s.nextStep}`);
  return parts.join('\n\n');
}

/** First message + summary, then the kept tail. The tail starts with an assistant turn. */
export function applySummary(first: Message, summary: string, tail: readonly Message[]): Message[] {
  return [{ role: 'user', content: [...first.content, { type: 'text', text: summary }] }, ...tail];
}

export type Summarize = (head: readonly Message[]) => Promise<CycleSummary | undefined>;

export type CompactionEvent =
  | { kind: 'cleared'; cleared: number; chars: number; tokensBefore: number; tokensAfter: number }
  | { kind: 'compacted'; turnsSummarized: number; tokensBefore: number; tokensAfter: number }
  | { kind: 'compact_failed'; reason: string; tokens: number };

/** Run both steps as needed before a turn. `first` is the cycle's original first message. */
export async function manageContext(
  messages: Message[],
  first: Message,
  settings: CompactionSettings,
  summarize: Summarize | undefined,
  emit: (e: CompactionEvent) => void,
): Promise<Message[]> {
  let current = messages;
  let tokens = contextTokens(current);
  if (tokens > settings.clearAt) {
    const r = clearOldToolResults(current, settings.keepToolResults);
    if (r.cleared) {
      const after = contextTokens(r.messages);
      emit({
        kind: 'cleared',
        cleared: r.cleared,
        chars: r.chars,
        tokensBefore: tokens,
        tokensAfter: after,
      });
      current = r.messages;
      tokens = after;
    }
  }
  if (tokens <= settings.compactAt || !summarize) return current;
  const split = splitForCompaction(current, settings.keepTurns);
  if (!split) {
    emit({ kind: 'compact_failed', reason: 'too few turns to compact', tokens });
    return current;
  }
  // An earlier compaction's summary lives in the first message; carry it into the new one.
  const earlier = current[0]?.content.slice(first.content.length) ?? [];
  const head: Message[] = earlier.length
    ? [{ role: 'user', content: earlier }, ...split.head]
    : split.head;
  let summary: CycleSummary | undefined;
  try {
    summary = await summarize(head);
  } catch (err) {
    emit({ kind: 'compact_failed', reason: (err as Error).message, tokens });
    return current;
  }
  if (!summary) {
    emit({ kind: 'compact_failed', reason: 'no summary (budget or malformed answer)', tokens });
    return current;
  }
  const next = applySummary(first, renderSummary(summary), split.tail);
  const after = contextTokens(next);
  emit({
    kind: 'compacted',
    turnsSummarized: split.head.filter((m) => m.role === 'assistant').length,
    tokensBefore: tokens,
    tokensAfter: after,
  });
  return next;
}
