import { z } from 'zod';
import { CHARS_PER_TOKEN, estimateTokens } from '../core/tokens.js';
import type { ContentBlock, Message } from '../providers/types.js';
import { enforceBudget } from './budget-guard.js';
import { pruneRules } from './prune-rules.js';
import {
  analysisIn,
  mergeWorkingState,
  parseWorkingState,
  renderWorkingState,
  tombstonesIn,
} from './working-state.js';

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
  /**
   * The user's context budget (the Memory slider, clamped to the window). The history never
   * leaves manageContext above it: the largest blocks become digests when folding isn't enough.
   */
  budget?: number;
  /** Text the fold keeps word for word (the think phase's analysis). */
  pinned?: string;
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
  /** Choices made and why, one line each. */
  decisions: z.array(z.string().max(300)).max(20).optional(),
  /** Approaches that failed and must not be repeated, one line each. */
  failed: z.array(z.string().max(400)).max(20).optional(),
  /** "path — what matters about it now" (not its contents). */
  keyFiles: z.array(z.string().max(300)).max(60).optional(),
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

const SUPERSEDED_PREFIX = '[superseded by omnexx:';
/** Results shorter than this aren't worth a cache miss to stub. */
const MIN_SUPERSEDE_CHARS = 400;

interface CallInfo {
  name: string;
  input: Record<string, unknown>;
}

const field = (input: Record<string, unknown>, k: string): unknown => input[k];
const lineOf = (input: Record<string, unknown>, k: string): number | undefined => {
  const v = field(input, k);
  return typeof v === 'number' ? v : undefined;
};

/** Does a later read cover an earlier one: same file, and the whole file or a wider range. */
function covers(later: Record<string, unknown>, earlier: Record<string, unknown>): boolean {
  if (field(later, 'path') !== field(earlier, 'path')) return false;
  const ls = lineOf(later, 'start');
  const le = lineOf(later, 'end');
  if (ls === undefined && le === undefined) return true;
  const es = lineOf(earlier, 'start');
  const ee = lineOf(earlier, 'end');
  if (es === undefined || ee === undefined) return false;
  return (ls ?? 1) <= es && le !== undefined && le >= ee;
}

/** Why an earlier result is dead weight given every result after it, or undefined if it isn't. */
function supersededBy(
  call: CallInfo,
  isError: boolean,
  later: readonly { call: CallInfo; isError: boolean }[],
): string | undefined {
  if (
    call.name === 'read' &&
    later.some((l) => l.call.name === 'read' && covers(l.call.input, call.input))
  )
    return `${String(field(call.input, 'path'))} was read again later; that read is current`;
  const command = field(call.input, 'command');
  if (
    call.name === 'bash' &&
    isError &&
    typeof command === 'string' &&
    later.some(
      (l) => l.call.name === 'bash' && !l.isError && field(l.call.input, 'command') === command,
    )
  )
    return `\`${clip(command, 120)}\` failed here and passed later; the failure is resolved`;
  return undefined;
}

/**
 * Stub tool results that later steps made dead weight: a file read again later (same lines or
 * the whole file), and a command that failed and then passed. Deterministic and free; the call
 * and its result stay paired, so every provider accepts the history. Returns new messages.
 */
export function pruneSuperseded(messages: readonly Message[]): {
  messages: Message[];
  pruned: number;
  chars: number;
} {
  const calls = new Map<string, CallInfo>();
  for (const m of messages)
    for (const b of m.content)
      if (b.type === 'tool_use')
        calls.set(b.id, {
          name: b.name,
          input:
            typeof b.input === 'object' && b.input !== null
              ? (b.input as Record<string, unknown>)
              : {},
        });
  const order: {
    at: [number, number];
    call: CallInfo;
    isError: boolean;
    size: number;
    done: boolean;
  }[] = [];
  messages.forEach((m, i) => {
    m.content.forEach((b, j) => {
      const call = b.type === 'tool_result' ? calls.get(b.toolUseId) : undefined;
      if (b.type !== 'tool_result' || !call) return;
      order.push({
        at: [i, j],
        call,
        isError: b.isError === true,
        size: b.content.length,
        done: b.content.startsWith(SUPERSEDED_PREFIX) || b.content.startsWith(CLEARED_PREFIX),
      });
    });
  });
  const stubs = new Map<string, string>();
  let chars = 0;
  order.forEach((r, k) => {
    if (r.done || r.size < MIN_SUPERSEDE_CHARS) return;
    const why = supersededBy(r.call, r.isError, order.slice(k + 1));
    if (!why) return;
    stubs.set(String(r.at), `${SUPERSEDED_PREFIX} ${why}]`);
    chars += r.size;
  });
  if (!stubs.size) return { messages: [...messages], pruned: 0, chars: 0 };
  const out = messages.map((m, i) => {
    if (!m.content.some((_, j) => stubs.has(String([i, j])))) return m;
    return {
      ...m,
      content: m.content.map((b, j): ContentBlock => {
        const stub = stubs.get(String([i, j]));
        return stub && b.type === 'tool_result' ? { ...b, content: stub } : b;
      }),
    };
  });
  return { messages: out, pruned: stubs.size, chars };
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
  const decisions = listOf(o.decisions, 20, 300);
  const failed = listOf(o.failed, 20, 400);
  const keyFiles = listOf(o.keyFiles, 60, 300);
  const r = cycleSummarySchema.safeParse({
    done: listOf(o.done, 30, 300),
    inProgress: inProgress ?? '',
    filesTouched: listOf(o.filesTouched, 60, 200),
    nextStep: nextStep ?? '',
    ...(lastError ? { lastError } : {}),
    ...(todos.length ? { openTodos: todos } : {}),
    ...(decisions.length ? { decisions } : {}),
    ...(failed.length ? { failed } : {}),
    ...(keyFiles.length ? { keyFiles } : {}),
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

export function renderSummary(s: CycleSummary, pinned?: string, tombstones?: string[]): string {
  return renderWorkingState(s, {
    ...(pinned ? { analysis: pinned } : {}),
    ...(tombstones?.length ? { tombstones } : {}),
  });
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

/** Fold `head` (the turns since the last fold); `prior` is the working state they continue. */
export type Summarize = (
  head: readonly Message[],
  prior?: CycleSummary,
) => Promise<CycleSummary | undefined>;

export type CompactionEvent =
  | { kind: 'pruned'; pruned: number; chars: number; tokensBefore: number; tokensAfter: number }
  | { kind: 'cleared'; cleared: number; chars: number; tokensBefore: number; tokensAfter: number }
  | { kind: 'compacted'; turnsSummarized: number; tokensBefore: number; tokensAfter: number }
  | { kind: 'compact_failed'; reason: string; tokens: number }
  | { kind: 'digested'; digested: number; tokensBefore: number; tokensAfter: number };

type Emit = (e: CompactionEvent) => void;

/** After a fold, the kept tail is digested down to this share of the budget (newest turn spared). */
export const SETTLE_FRACTION = 0.4;

const minClearChars = (settings: CompactionSettings): number =>
  (settings.minClearTokens ?? Math.min(MIN_CLEAR_TOKENS, settings.clearAt / 10)) * CHARS_PER_TOKEN;

interface Step {
  messages: Message[];
  tokens: number;
}

/**
 * Drop superseded material: always once past `clearAt`, and below it as soon as enough would go
 * to pay for the cache miss the rewrite causes (continuous pruning, batched by size).
 */
function prune(messages: Message[], settings: CompactionSettings, emit: Emit): Step {
  const tokens = contextTokens(messages);
  const s = pruneSuperseded(messages);
  const r = pruneRules(s.messages, settings.keepTurns);
  const chars = s.chars + r.chars;
  const count = s.pruned + r.pruned;
  if (!count || (tokens <= settings.clearAt && chars < minClearChars(settings)))
    return { messages, tokens };
  const after = contextTokens(r.messages);
  emit({ kind: 'pruned', pruned: count, chars, tokensBefore: tokens, tokensAfter: after });
  return { messages: r.messages, tokens: after };
}

function clear(step: Step, settings: CompactionSettings, emit: Emit): Step {
  if (step.tokens <= settings.clearAt) return step;
  const r = clearOldToolResults(step.messages, settings.keepToolResults, minClearChars(settings));
  if (!r.cleared) return step;
  const after = contextTokens(r.messages);
  emit({
    kind: 'cleared',
    cleared: r.cleared,
    chars: r.chars,
    tokensBefore: step.tokens,
    tokensAfter: after,
  });
  return { messages: r.messages, tokens: after };
}

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');

/**
 * Fold everything older than the last `keepTurns` turns into the working state, merged with the
 * previous one (handed to the folder as `prior`, not re-summarized from its rendering). The goal
 * (first message), the pinned analysis and the tombstones survive word for word.
 */
async function fold(
  step: Step,
  first: Message,
  settings: CompactionSettings,
  summarize: Summarize,
  emit: Emit,
): Promise<Message[]> {
  const { messages: current, tokens } = step;
  const split = splitForCompaction(current, settings.keepTurns);
  if (!split) {
    emit({ kind: 'compact_failed', reason: 'too few turns to compact', tokens });
    return current;
  }
  const earlier = textOf(current[0]?.content.slice(first.content.length) ?? []);
  const prior = parseWorkingState(earlier);
  let summary: CycleSummary | undefined;
  try {
    summary = await summarize(split.head, prior);
  } catch (err) {
    emit({ kind: 'compact_failed', reason: (err as Error).message, tokens });
    return current;
  }
  if (!summary) {
    emit({ kind: 'compact_failed', reason: 'no summary (budget or malformed answer)', tokens });
    return current;
  }
  const pinned = settings.pinned?.trim() ? settings.pinned : analysisIn(earlier);
  const state = renderSummary(mergeWorkingState(prior, summary), pinned, tombstonesIn(split.head));
  // The fold rewrites everything after the working state anyway, so shrinking the kept tail now
  // costs no extra cache miss, and it keeps the next fold far away (cost-sim.test.ts).
  const folded = applySummary(first, state, split.tail);
  const next =
    settings.budget === undefined
      ? folded
      : enforceBudget(folded, Math.floor(settings.budget * SETTLE_FRACTION), true).messages;
  emit({
    kind: 'compacted',
    turnsSummarized: split.head.filter((m) => m.role === 'assistant').length,
    tokensBefore: tokens,
    tokensAfter: contextTokens(next),
  });
  return next;
}

/**
 * Before a turn: prune superseded material, clear old tool results past `clearAt`, fold into the
 * working state past `compactAt`, and never leave the history over `budget`. `first` is the
 * cycle's original first message.
 */
export async function manageContext(
  messages: Message[],
  first: Message,
  settings: CompactionSettings,
  summarize: Summarize | undefined,
  emit: Emit,
): Promise<Message[]> {
  const cleared = clear(prune(messages, settings, emit), settings, emit);
  const current =
    cleared.tokens > settings.compactAt && summarize
      ? await fold(cleared, first, settings, summarize, emit)
      : cleared.messages;
  if (settings.budget === undefined) return current;
  const g = enforceBudget(current, settings.budget);
  if (g.digested)
    emit({
      kind: 'digested',
      digested: g.digested,
      tokensBefore: contextTokens(current),
      tokensAfter: g.tokens,
    });
  return g.messages;
}
