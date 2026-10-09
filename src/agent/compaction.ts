import { z } from 'zod';
import { CHARS_PER_TOKEN, estimateTokens } from '../core/tokens.js';
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
  /** Clear only when at least this many tokens would go (default: MIN_CLEAR_TOKENS or clearAt/10). */
  minClearTokens?: number;
}

/** Below this a clear saves less than the cache miss it causes on the next turn. */
export const MIN_CLEAR_TOKENS = 4_000;

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
  /** Unfinished items of the agent's `todo` checklist, as "[status] text". */
  openTodos: z.array(z.string().max(220)).max(30).optional(),
});
export type CycleSummary = z.infer<typeof cycleSummarySchema>;

/** Roughly what a vision model charges for one image, whatever its base64 length. */
const IMAGE_TOKENS = 1_500;

export function contextTokens(messages: readonly Message[]): number {
  let images = 0;
  const text = JSON.stringify(messages, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'image') {
      images++;
      return undefined;
    }
    return v;
  });
  return estimateTokens(text) + images * IMAGE_TOKENS;
}

/** `[exit 1, 812ms, log cmd-3-2]` at the top of a bash result names the log that keeps it whole. */
const LOG_ID = /^\[[^\]\n]*\blog ([\w.-]+)\]/;

/** How to get a cleared result back: the bash log when there is one, else the same call again. */
export function clearedStub(
  content: string,
  call: { name: string; input: unknown } | undefined,
): string {
  const log = LOG_ID.exec(content)?.[1];
  const what = call ? `${call.name} ${clip(JSON.stringify(call.input), 160)}` : 'a tool call';
  const back = log ? `read_log id="${log}" has it all` : 'repeat the call if you still need it';
  return `${CLEARED_PREFIX} ${content.length} chars of old output from ${what}; ${back}]`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Replace the content of all but the newest `keep` tool results that are large, with a note that
 * names the call and how to get the data back. Every clear rewrites earlier messages and so
 * costs a prompt-cache miss: unless at least `minChars` would go, nothing is cleared.
 * Returns new messages; the input is not mutated.
 */
export function clearOldToolResults(
  messages: readonly Message[],
  keep: number,
  minChars = 0,
): { messages: Message[]; cleared: number; chars: number } {
  const positions: [number, number][] = [];
  const calls = new Map<string, { name: string; input: unknown }>();
  messages.forEach((m, i) => {
    m.content.forEach((b, j) => {
      if (b.type === 'tool_result') positions.push([i, j]);
      else if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input });
    });
  });
  const clearable = (b: ContentBlock) =>
    b.type === 'tool_result' &&
    b.content.length >= MIN_CLEAR_CHARS &&
    !b.content.startsWith(CLEARED_PREFIX);
  const old = new Set<string>();
  let total = 0;
  for (const [i, j] of positions.slice(0, Math.max(0, positions.length - keep))) {
    const b = messages[i]?.content[j];
    if (b?.type !== 'tool_result' || !clearable(b)) continue;
    old.add(String([i, j]));
    total += b.content.length;
  }
  if (!old.size || total < minChars) return { messages: [...messages], cleared: 0, chars: 0 };
  const out = messages.map((m, i) => {
    if (!m.content.some((_, j) => old.has(String([i, j])))) return m;
    const content = m.content.map((b, j): ContentBlock => {
      if (b.type !== 'tool_result' || !old.has(String([i, j]))) return b;
      return { ...b, content: clearedStub(b.content, calls.get(b.toolUseId)) };
    });
    return { ...m, content };
  });
  return { messages: out, cleared: old.size, chars: total };
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

const clipTo = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, n) : undefined;
const listOf = (v: unknown, items: number, chars: number): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .flatMap((x: unknown) => (typeof x === 'string' ? [x.slice(0, chars)] : []))
    .slice(0, items);

/**
 * Weak models overshoot the limits (31 items, a long line) or send a list as one string. Clip
 * to the schema instead of throwing the whole compaction away; undefined only when it is unusable.
 */
export function coerceSummary(input: unknown): CycleSummary | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const inProgress = clipTo(o.inProgress, 600);
  const nextStep = clipTo(o.nextStep, 600);
  if (inProgress === undefined && nextStep === undefined) return undefined;
  const lastError = clipTo(o.lastError, 1_000);
  const todos = listOf(o.openTodos, 30, 220);
  const r = cycleSummarySchema.safeParse({
    done: listOf(o.done, 30, 300),
    inProgress: inProgress ?? '',
    filesTouched: listOf(o.filesTouched, 60, 200),
    nextStep: nextStep ?? '',
    ...(lastError ? { lastError } : {}),
    ...(todos.length ? { openTodos: todos } : {}),
  });
  return r.success ? r.data : undefined;
}

/**
 * A summary from the transcript alone, for when the cheap model is unavailable or its answer is
 * unusable: compacting with less is better than letting the context grow to the cycle cap.
 * `ensureFacts` adds files, the last error and open todos on top.
 */
export function factSummary(head: readonly Message[]): CycleSummary {
  const calls: string[] = [];
  let lastText = '';
  for (const m of head)
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.push(`${b.name} ${clip(JSON.stringify(b.input), 200)}`);
      else if (b.type === 'text' && m.role === 'assistant' && b.text.trim()) lastText = b.text;
    }
  return {
    done: calls.slice(-30).map((c) => `called ${c}`.slice(0, 300)),
    inProgress: (lastText.trim() || 'see the calls above').slice(0, 600),
    filesTouched: [],
    nextStep: 'Continue the task from where these calls left off.',
  };
}

export function renderSummary(s: CycleSummary): string {
  const parts = ['# Earlier in this cycle (compacted summary)'];
  if (s.done.length) parts.push(`Done:\n${s.done.map((d) => `- ${d}`).join('\n')}`);
  parts.push(`In progress: ${s.inProgress}`);
  if (s.filesTouched.length) parts.push(`Files touched: ${s.filesTouched.join(', ')}`);
  if (s.lastError) parts.push(`Last error: ${s.lastError}`);
  if (s.openTodos?.length)
    parts.push(`${OPEN_TODOS_HEADER}\n${s.openTodos.map((t) => `- ${t}`).join('\n')}`);
  parts.push(`Next step: ${s.nextStep}`);
  return parts.join('\n\n');
}

const OPEN_TODOS_HEADER = 'Open todos (your todo list; send the whole list again to update it):';

/**
 * The unfinished items of the newest todo list in `head`: from the last `todo` call, else from
 * an earlier compaction's summary (which holds them as text). Undefined when there is neither.
 */
export function openTodos(head: readonly Message[]): string[] | undefined {
  for (let i = head.length - 1; i >= 0; i--) {
    const blocks = head[i]?.content ?? [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type === 'tool_use' && b.name === 'todo') {
        const items = (b.input as { items?: unknown }).items;
        if (!Array.isArray(items)) continue;
        return items.flatMap((it: unknown) => {
          const { text, status } = (it ?? {}) as { text?: unknown; status?: unknown };
          return typeof text === 'string' && status !== 'done'
            ? [`[${typeof status === 'string' ? status : 'pending'}] ${text}`.slice(0, 220)]
            : [];
        });
      }
      if (b?.type === 'text' && b.text.includes(OPEN_TODOS_HEADER)) {
        const block = b.text.split(OPEN_TODOS_HEADER)[1]?.split('\n\n')[0] ?? '';
        return block
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2));
      }
    }
  }
  return undefined;
}

/**
 * The cheap model's summary must not lose what the next turn depends on: every file edited
 * this cycle, the most recent error and the open todo items. Fill them in from the facts.
 */
export function ensureFacts(
  s: CycleSummary,
  head: readonly Message[],
  edited: Iterable<string>,
): CycleSummary {
  const files = [...new Set([...s.filesTouched, ...edited])].slice(0, 60);
  let lastError = s.lastError;
  if (!lastError?.trim()) {
    const errors = head.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'tool_result' && b.isError ? [b.content] : [])),
    );
    const last = errors.at(-1);
    if (last) lastError = last.slice(0, 1_000);
  }
  // The todo calls are facts; the summarizer's paraphrase of them is not.
  const todos = openTodos(head) ?? s.openTodos;
  return {
    ...s,
    filesTouched: files,
    ...(lastError ? { lastError } : {}),
    ...(todos?.length ? { openTodos: todos.slice(0, 30) } : {}),
  };
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
    const r = clearOldToolResults(
      current,
      settings.keepToolResults,
      (settings.minClearTokens ?? Math.min(MIN_CLEAR_TOKENS, settings.clearAt / 10)) *
        CHARS_PER_TOKEN,
    );
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
