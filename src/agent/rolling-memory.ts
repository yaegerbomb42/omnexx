import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitForCompaction, transcriptFor } from './compaction.js';
import type { Message } from '../providers/types.js';

/**
 * Rolling memory condensation: every few turns the agent's working memory is rewritten into
 * one compact, structured note instead of re-sending raw history. The raw transcript is
 * appended to `logs/transcript.md` first, so nothing is lost — `recall` can pull any detail
 * back. The note is bounded (~1,500 tokens), so the prompt stays roughly flat over a long run:
 * system + note + current working set + the last couple of turns raw.
 *
 * Deterministic on purpose: no model call, no new failure mode. The cheap-model fold in
 * compaction.ts stays as the token-ceiling safety net when `memory: full`.
 */

export const ROLLING_NOTE_HEADER = '# Memory (rolling)';
/** Hard character ceiling for the rendered note (~1,500 tokens). */
export const ROLLING_NOTE_CHAR_CAP = 6_000;
/** Turns between condensations when `memory: rolling` (the 6–8 turn cadence). */
export const DEFAULT_CONDENSE_EVERY = 7;
/** Raw turns kept verbatim after the note. */
export const DEFAULT_KEEP_TURNS = 2;

const GOAL = '## Current goal';
const ACTIVE = '## Active work (newest first)';
const DECISIONS = '## Decisions and why';
const FACTS = '## Facts';
const THREADS = '## Open threads (older work, one line each)';
const FAILED = "## Failed attempts (don't retry)";
const FOOTER =
  'Raw transcript: logs/transcript.md — use recall("<query>") for details this note trimmed.';

const KNOWN_HEADERS = [GOAL, ACTIVE, DECISIONS, FACTS, THREADS, FAILED] as const;

/** One recent piece of work, kept in full detail. */
export interface RollingWorkItem {
  title: string;
  detail: string[];
  turn: number;
}

/** A file the agent touched, with the hash of its current contents. */
export interface RollingFact {
  path: string;
  hash: string;
}

/** Older work, shrunk to one line — never dropped without saying so. */
export interface RollingThread {
  line: string;
  turn: number;
}

export interface RollingNote {
  goal: string;
  active: RollingWorkItem[];
  decisions: string[];
  facts: RollingFact[];
  threads: RollingThread[];
  failed: string[];
  /** First turn this note covers (the oldest condensed turn). */
  coversFrom: number;
  /** Last turn condensed into this note. */
  coversTo: number;
  /** Loop turn the note was written at (drives thread ages). */
  updatedTurn: number;
  /**
   * Oldest threads collapsed into one counted line when the note hit its cap. The count and
   * the turn range are rendered, so the collapse is explicit, never silent.
   */
  collapsed?: { count: number; fromTurn: number; toTurn: number };
}

export const emptyNote = (goal = '', turn = 0): RollingNote => ({
  goal,
  active: [],
  decisions: [],
  facts: [],
  threads: [],
  failed: [],
  coversFrom: Math.max(1, turn),
  coversTo: turn,
  updatedTurn: turn,
});

const singleLine = (s: string): string => s.replace(/\s*\n+\s*/g, ' ').trim();

const dedupe = (items: readonly string[]): string[] => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const norm = singleLine(i);
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
};

/** The newest N work items stay detailed; older ones shrink to one-line threads. */
const ACTIVE_DETAILED = 3;
const MAX_DECISIONS = 15;
const MAX_FAILED = 15;
const MAX_FACTS = 40;

function section(text: string, title: string): string | undefined {
  const marker = `${title}\n`;
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const body = text.slice(start + marker.length);
  let end = body.length;
  for (const h of KNOWN_HEADERS) {
    if (h === title) continue;
    const idx = body.indexOf(`\n\n${h}\n`);
    if (idx >= 0 && idx < end) end = idx;
  }
  return body.slice(0, end).trim();
}

const listIn = (text: string, title: string): string[] =>
  (section(text, title) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));

function threadAge(note: RollingNote, t: RollingThread): string {
  const age = Math.max(0, note.updatedTurn - t.turn);
  return `${t.line} — turn ${t.turn} (${age === 0 ? 'this turn' : `${age} turn${age === 1 ? '' : 's'} ago`})`;
}

/**
 * Render the note. When it would exceed `maxChars`, oldest threads collapse into one counted
 * line first, then active detail lines and older decisions/failed lines shed — the note always
 * says what it dropped and where to find it.
 */
export function renderRollingNote(note: RollingNote, maxChars = ROLLING_NOTE_CHAR_CAP): string {
  // Newest first everywhere; the collapse below sheds the oldest threads.
  let threads = [...note.threads].sort((a, b) => b.turn - a.turn);
  let collapsed = note.collapsed;
  let detailCap = Number.MAX_SAFE_INTEGER;
  let listCap = Number.MAX_SAFE_INTEGER;

  const build = (): string => {
    const parts = [
      `${ROLLING_NOTE_HEADER} (covers turns ${note.coversFrom}–${note.coversTo}; written at turn ${note.updatedTurn})`,
    ];
    parts.push(`${GOAL}\n${note.goal.trim() || '—'}`);
    if (note.active.length) {
      const items = note.active.slice(0, ACTIVE_DETAILED).map((w) => {
        const lines = [`- ${singleLine(w.title)} (turn ${w.turn})`];
        for (const d of w.detail.slice(0, detailCap)) lines.push(`  - ${singleLine(d)}`);
        return lines.join('\n');
      });
      parts.push(`${ACTIVE}\n${items.join('\n')}`);
    }
    if (note.decisions.length)
      parts.push(
        `${DECISIONS}\n${note.decisions
          .slice(-listCap)
          .map((d) => `- ${singleLine(d)}`)
          .join('\n')}`,
      );
    if (note.facts.length)
      parts.push(`${FACTS}\n${note.facts.map((f) => `- ${f.path} — sha256:${f.hash}`).join('\n')}`);
    if (threads.length || collapsed) {
      const lines = threads.map((t) => `- ${threadAge(note, t)}`);
      if (collapsed)
        lines.push(
          `- …and ${collapsed.count} older thread${collapsed.count === 1 ? '' : 's'} (turns ${collapsed.fromTurn}–${collapsed.toTurn}) — recall them from logs/transcript.md`,
        );
      parts.push(`${THREADS}\n${lines.join('\n')}`);
    }
    if (note.failed.length)
      parts.push(
        `${FAILED}\n${note.failed
          .slice(-listCap)
          .map((f) => `- ${singleLine(f)}`)
          .join('\n')}`,
      );
    parts.push(FOOTER);
    return parts.join('\n\n');
  };

  let rendered = build();
  while (rendered.length > maxChars) {
    if (threads.length > 1) {
      // Collapse the oldest threads into the counted line, oldest first.
      const n = Math.max(1, Math.floor(threads.length / 2));
      const drop = threads.slice(-n);
      threads = threads.slice(0, -n);
      const fromTurn = Math.min(...drop.map((t) => t.turn));
      const toTurn = Math.max(...drop.map((t) => t.turn));
      collapsed = {
        count: (collapsed?.count ?? 0) + drop.length,
        fromTurn: collapsed ? Math.min(collapsed.fromTurn, fromTurn) : fromTurn,
        toTurn: collapsed ? Math.max(collapsed.toTurn, toTurn) : toTurn,
      };
    } else if (detailCap > 2) {
      detailCap = 2;
    } else if (listCap > 8) {
      listCap = 8;
    } else if (detailCap > 0) {
      detailCap = 0;
    } else {
      rendered = `${rendered.slice(0, maxChars - 24)}\n…[note trimmed to fit]`;
      break;
    }
    rendered = build();
  }
  return rendered;
}

/** Read a rendered rolling note back; undefined when `text` holds none. */
export function parseRollingNote(text: string): RollingNote | undefined {
  const at = text.indexOf(ROLLING_NOTE_HEADER);
  if (at < 0) return undefined;
  const t = text.slice(at);
  const cover = /\(covers turns (\d+)–(\d+); written at turn (\d+)\)/.exec(t);
  const goal = section(t, GOAL);
  const activeRaw = section(t, ACTIVE) ?? '';
  const active: RollingWorkItem[] = [];
  let current: RollingWorkItem | undefined;
  for (const line of activeRaw.split('\n')) {
    const head = /^- (.+) \(turn (\d+)\)$/.exec(line);
    if (head) {
      current = { title: head[1] ?? '', detail: [], turn: Number(head[2]) };
      active.push(current);
    } else if (line.startsWith('  - ') && current) {
      current.detail.push(line.slice(4));
    }
  }
  const threads: RollingThread[] = [];
  let collapsed: RollingNote['collapsed'];
  for (const line of listIn(t, THREADS)) {
    const m = /^(.*) — turn (\d+) \(.*\)$/.exec(line);
    if (m) threads.push({ line: m[1] ?? '', turn: Number(m[2]) });
    else {
      const c = /^…and (\d+) older threads? \(turns (\d+)–(\d+)\)/.exec(line);
      if (c)
        collapsed = {
          count: Number(c[1]),
          fromTurn: Number(c[2]),
          toTurn: Number(c[3]),
        };
    }
  }
  const facts: RollingFact[] = [];
  for (const line of listIn(t, FACTS)) {
    const m = /^(.+) — sha256:([0-9a-f]+|unknown)$/.exec(line);
    if (m) facts.push({ path: m[1] ?? '', hash: m[2] ?? 'unknown' });
  }
  return {
    goal: goal?.trim() ?? '',
    active,
    decisions: listIn(t, DECISIONS),
    facts,
    threads,
    failed: listIn(t, FAILED),
    coversFrom: cover ? Number(cover[1]) : 1,
    coversTo: cover ? Number(cover[2]) : 0,
    updatedTurn: cover ? Number(cover[3]) : 0,
    ...(collapsed ? { collapsed } : {}),
  };
}

/** The rendered note in `messages[0]`, if a previous condense left one there. */
export function noteInFirst(messages: readonly Message[]): RollingNote | undefined {
  const first = messages[0];
  if (!first) return undefined;
  const text = first.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
  return parseRollingNote(text);
}

/** Fold due when at least `every` turns passed since the last fold. */
export function shouldCondense(turn: number, lastFoldTurn: number, every: number): boolean {
  return turn - lastFoldTurn >= every;
}

const EDIT_TOOLS = new Set(['write_file', 'str_replace', 'create_file', 'edit', 'edit_file']);
const PATH_KEYS = ['path', 'file_path', 'filepath', 'file'];

const inputOf = (b: Extract<Message['content'][number], { type: 'tool_use' }>) =>
  typeof b.input === 'object' && b.input !== null
    ? (b.input as Record<string, unknown>)
    : ({} as Record<string, unknown>);

const pathOf = (input: Record<string, unknown>): string | undefined => {
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
};

const DECISION_RE =
  /\b(decision|decided?|chose|choose|choosing|going with|instead of|rather than|will use|switched to|settled on)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => singleLine(s))
    .filter(Boolean);
}

const sha12 = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 12);

interface TurnExtract {
  turn: number;
  item: RollingWorkItem | undefined;
  decisions: string[];
  failed: string[];
  editedPaths: string[];
}

/** Pull work items, decisions and failures out of one assistant turn + its tool results. */
function extractTurn(assistant: Message, result: Message | undefined, turn: number): TurnExtract {
  const text = assistant.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();
  const calls = assistant.content.filter(
    (b): b is Extract<Message['content'][number], { type: 'tool_use' }> => b.type === 'tool_use',
  );
  const results = (result?.content ?? []).filter(
    (b): b is Extract<Message['content'][number], { type: 'tool_result' }> =>
      b.type === 'tool_result',
  );
  const byId = new Map(calls.map((c) => [c.id, c]));
  const detail: string[] = [];
  const editedPaths: string[] = [];
  const failed: string[] = [];
  let sawWork = false;
  for (const c of calls) {
    const input = inputOf(c);
    if (EDIT_TOOLS.has(c.name.toLowerCase())) {
      const p = pathOf(input);
      if (p) {
        editedPaths.push(p);
        detail.push(`edited ${p}`);
        sawWork = true;
      }
    } else if (c.name.toLowerCase() === 'bash' && typeof input.command === 'string') {
      detail.push(`ran \`${singleLine(input.command).slice(0, 100)}\``);
      sawWork = true;
    } else if (c.name.toLowerCase() === 'todo' && Array.isArray(input.items)) {
      for (const it of input.items as { text?: unknown; status?: unknown }[]) {
        if (typeof it.text === 'string' && it.status === 'done')
          detail.push(`done: ${singleLine(it.text).slice(0, 120)}`);
      }
      sawWork = true;
    }
  }
  for (const r of results) {
    if (!r.isError) continue;
    const call = byId.get(r.toolUseId);
    failed.push(
      `turn ${turn}: ${call?.name ?? 'tool'} — ${singleLine(r.content).slice(0, 200) || '(no error text)'}`,
    );
  }
  const decisions = sentences(text)
    .filter((s) => DECISION_RE.test(s))
    .map((s) => s.slice(0, 200));
  const title = text.split('\n')[0]?.slice(0, 120) ?? '';
  const item =
    sawWork || (text && calls.length > 0)
      ? {
          title: title || (editedPaths[0] ? `edited ${editedPaths[0]}` : 'worked a turn'),
          detail: dedupe(detail).slice(0, 6),
          turn,
        }
      : undefined;
  return { turn, item, decisions, failed, editedPaths };
}

/**
 * Rewrite the folded turns into a new note, merged with the previous one: the newest work
 * stays detailed, older work shrinks to one-line threads, decisions and failures accumulate
 * (newest kept), facts refresh to the files' current hashes.
 */
export async function condense(
  head: readonly Message[],
  prior: RollingNote | undefined,
  opts: {
    goal: string;
    /** Loop turn the note is written at (drives thread ages and `updatedTurn`). */
    turn: number;
    /** Turn number of the last assistant message in `head` (turn − keepTurns). */
    headLastTurn: number;
    readFile?: (path: string) => Promise<string | undefined>;
  },
): Promise<RollingNote> {
  // Assistant turns in the head, oldest first; the last one is `headLastTurn`.
  const assistants = head.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
  const firstTurn = opts.headLastTurn - assistants.length + 1;
  const extracts: TurnExtract[] = assistants.map((idx, k) => {
    const turn = firstTurn + k;
    // The user message right after this assistant message holds its tool results.
    const next = head[idx + 1];
    return extractTurn(head[idx] as Message, next?.role === 'user' ? next : undefined, turn);
  });

  const freshItems = extracts.flatMap((e) => (e.item ? [e.item] : []));
  const freshDecisions = dedupe(extracts.flatMap((e) => e.decisions));
  const freshFailed = dedupe(extracts.flatMap((e) => e.failed));
  const freshPaths = [...new Set(extracts.flatMap((e) => e.editedPaths))];

  const freshFacts: RollingFact[] = [];
  for (const p of freshPaths) {
    let hash = 'unknown';
    if (opts.readFile) {
      const content = await opts.readFile(p).catch(() => undefined);
      if (content !== undefined) hash = sha12(content);
    }
    freshFacts.push({ path: p, hash });
  }

  // Recency weighting: the newest items stay detailed; everything older becomes a thread line.
  const allItems = [...(prior?.active ?? []), ...freshItems].sort((a, b) => b.turn - a.turn);
  const active = allItems.slice(0, ACTIVE_DETAILED);
  const demoted: RollingThread[] = allItems
    .slice(ACTIVE_DETAILED)
    .map((w) => ({ line: w.title, turn: w.turn }));
  const threads = dedupeThreads([...(prior?.threads ?? []), ...demoted]);
  const factsByPath = new Map<string, RollingFact>();
  for (const f of [...(prior?.facts ?? []), ...freshFacts]) factsByPath.set(f.path, f);
  return {
    goal: opts.goal.trim() ? opts.goal : (prior?.goal ?? ''),
    active,
    decisions: dedupe([...(prior?.decisions ?? []), ...freshDecisions]).slice(-MAX_DECISIONS),
    facts: [...factsByPath.values()].slice(-MAX_FACTS),
    threads,
    failed: dedupe([...(prior?.failed ?? []), ...freshFailed]).slice(-MAX_FAILED),
    coversFrom: prior?.coversFrom ?? Math.max(1, firstTurn),
    coversTo: opts.headLastTurn,
    updatedTurn: opts.turn,
    ...(prior?.collapsed ? { collapsed: prior.collapsed } : {}),
  };
}

function dedupeThreads(items: readonly RollingThread[]): RollingThread[] {
  const seen = new Set<string>();
  return items
    .filter((t) => {
      const key = `${t.turn}:${singleLine(t.line)}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.turn - a.turn);
}

/** Replace Slot 7 (the second block of `first`) with the note, keeping the tail raw. */
export function applyRollingNote(
  first: Message,
  note: string,
  tail: readonly Message[],
): Message[] {
  const anchor = first.content[0];
  const content: Message['content'] = anchor
    ? [anchor, { type: 'text', text: note }]
    : [{ type: 'text', text: note }];
  return [{ role: 'user', content }, ...tail];
}

export interface CondenseResult {
  messages: Message[];
  note: string;
  /** Assistant turns folded into the note this time. */
  turnsSummarized: number;
}

/**
 * One condense step over `messages`: fold everything older than the last `keepTurns` turns
 * into the rolling note (merged with the note already in `messages[0]`, if any), append the
 * folded transcript to disk via `persistTranscript`, and return the shortened conversation:
 * anchor + note + the last `keepTurns` turns raw. Undefined when too few turns are old enough.
 */
export async function condenseRolling(
  messages: readonly Message[],
  anchor: Message,
  opts: {
    turn: number;
    goal: string;
    keepTurns: number;
    readFile?: (path: string) => Promise<string | undefined>;
    persistTranscript?: (text: string) => Promise<void>;
  },
): Promise<CondenseResult | undefined> {
  const split = splitForCompaction(messages, opts.keepTurns);
  if (!split) return undefined;
  const prior = noteInFirst(messages);
  const note = await condense(split.head, prior, {
    goal: opts.goal,
    turn: opts.turn,
    headLastTurn: opts.turn - opts.keepTurns,
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
  });
  const rendered = renderRollingNote(note);
  if (opts.persistTranscript) {
    const from = (prior?.coversTo ?? 0) + 1;
    const to = opts.turn - opts.keepTurns;
    const text = `## Turns ${from}–${to} (condensed at turn ${opts.turn})\n\n${transcriptFor(split.head)}\n`;
    await opts.persistTranscript(text).catch(() => undefined);
  }
  return {
    messages: applyRollingNote(anchor, rendered, split.tail),
    note: rendered,
    turnsSummarized: split.head.filter((m) => m.role === 'assistant').length,
  };
}

/** Append a condensed transcript chunk to `logs/transcript.md`, creating the dir if needed. */
export async function appendTranscriptFile(dir: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, 'transcript.md'), text, { mode: 0o600 });
}
