import type { ContentBlock, Message } from '../providers/types.js';

/**
 * Continuous, model-free pruning of material later steps made dead weight, on top of
 * `pruneSuperseded` (re-reads, failed-then-passed commands). Each rule stubs a tool result or an
 * old narration text in place, so every tool_use keeps its tool_result and the history stays
 * valid for every provider. Pure: returns new messages.
 *
 * Rules:
 * - stale read: a `read` of a file that was edited or rewritten afterwards (its lines moved on);
 * - failed edit: an edit that failed on a file a later edit of the same file changed;
 * - covered search: a `search`/`list` result whose files were all read afterwards;
 * - narration: assistant text of old turns that also called tools ("let me look at …"),
 *   outside the last `keepTurns` assistant turns.
 */

export const PRUNED_PREFIX = '[pruned by omnexx:';
const OTHER_STUBS = ['[superseded by omnexx:', '[cleared by omnexx:', '[digest by omnexx:'];
/** Results shorter than this aren't worth the cache miss a stub causes. */
const MIN_PRUNE_CHARS = 400;
/** Narration shorter than this stays: a stub would be about as long. */
const MIN_NARRATION_CHARS = 160;
/** A search counts as covered when the lines naming no later-read file are under this share. */
const UNCOVERED_SHARE = 0.2;
const NARRATION_KEEP_CHARS = 80;

const EDIT_TOOLS = new Set(['str_replace', 'multi_edit', 'write_file', 'replace_lines']);
const SEARCH_TOOLS = new Set(['search', 'list']);

interface Result {
  at: readonly [number, number];
  name: string;
  path: string | undefined;
  isError: boolean;
  content: string;
}

export interface PruneOutcome {
  messages: Message[];
  pruned: number;
  chars: number;
  /** How many of each rule fired, for events and tests. */
  byRule: Readonly<Record<PruneRule, number>>;
}

export type PruneRule = 'stale_read' | 'failed_edit' | 'covered_search' | 'narration';

const isStub = (s: string): boolean =>
  s.startsWith(PRUNED_PREFIX) || OTHER_STUBS.some((p) => s.startsWith(p));

function pathOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const p = (input as Record<string, unknown>).path;
  if (typeof p === 'string') return p;
  const files = (input as Record<string, unknown>).files;
  if (Array.isArray(files) && files.length === 1 && typeof files[0] === 'object' && files[0] !== null) {
    const fPath = (files[0] as Record<string, unknown>).path;
    if (typeof fPath === 'string') return fPath;
  }
  return undefined;
}

function results(messages: readonly Message[]): Result[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const m of messages)
    for (const b of m.content)
      if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input });
  const out: Result[] = [];
  messages.forEach((m, i) => {
    m.content.forEach((b, j) => {
      if (b.type !== 'tool_result') return;
      const call = calls.get(b.toolUseId);
      if (!call) return;
      out.push({
        at: [i, j],
        name: call.name,
        path: pathOf(call.input),
        isError: b.isError === true,
        content: b.content,
      });
    });
  });
  return out;
}

const laterEditOf = (later: readonly Result[], path: string): boolean =>
  later.some((l) => EDIT_TOOLS.has(l.name) && !l.isError && l.path === path);

function coveredBy(content: string, readPaths: ReadonlySet<string>): boolean {
  if (!readPaths.size) return false;
  const lines = content.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  const named = (l: string) => [...readPaths].some((p) => l.includes(p));
  if (!lines.some(named)) return false;
  const uncovered = lines.filter((l) => !named(l)).join('\n').length;
  return uncovered < content.length * UNCOVERED_SHARE;
}

/** Why a tool result is dead weight, or undefined. */
function ruleFor(
  r: Result,
  later: readonly Result[],
): { rule: PruneRule; why: string } | undefined {
  if (r.content.length < MIN_PRUNE_CHARS || isStub(r.content)) return undefined;
  if (r.name === 'read' && r.path && !r.isError && laterEditOf(later, r.path))
    return { rule: 'stale_read', why: `${r.path} was edited after this read; read it again` };
  if (EDIT_TOOLS.has(r.name) && r.isError && r.path && laterEditOf(later, r.path))
    return { rule: 'failed_edit', why: `this edit of ${r.path} failed; a later edit succeeded` };
  if (SEARCH_TOOLS.has(r.name) && !r.isError) {
    const read = new Set(
      later.flatMap((l) => (l.name === 'read' && l.path && !l.isError ? [l.path] : [])),
    );
    if (coveredBy(r.content, read))
      return { rule: 'covered_search', why: 'every file it found was read afterwards' };
  }
  return undefined;
}

/** Indices of assistant messages older than the last `keepTurns` that also call tools. */
function oldNarrators(messages: readonly Message[], keepTurns: number): Set<number> {
  const assistants = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
  const old = assistants.slice(0, Math.max(0, assistants.length - keepTurns));
  return new Set(
    // Opaque blocks (signed thinking) bind the turn's text: leave those turns as they are.
    old.filter((i) => {
      const c = messages[i]?.content ?? [];
      return c.some((b) => b.type === 'tool_use') && !c.some((b) => b.type === 'opaque');
    }),
  );
}

function narrationStub(text: string): string {
  const head = text.trim().replace(/\s+/g, ' ').slice(0, NARRATION_KEEP_CHARS);
  return `${PRUNED_PREFIX} narration] ${head}…`;
}

export function pruneRules(messages: readonly Message[], keepTurns: number): PruneOutcome {
  const all = results(messages);
  const stubs = new Map<string, string>();
  const byRule: Record<PruneRule, number> = {
    stale_read: 0,
    failed_edit: 0,
    covered_search: 0,
    narration: 0,
  };
  let chars = 0;
  all.forEach((r, k) => {
    const hit = ruleFor(r, all.slice(k + 1));
    if (!hit) return;
    stubs.set(String(r.at), `${PRUNED_PREFIX} ${hit.why}]`);
    byRule[hit.rule]++;
    chars += r.content.length;
  });
  const narrators = oldNarrators(messages, keepTurns);
  const out = messages.map((m, i) => {
    const narrate = narrators.has(i);
    if (!narrate && !m.content.some((_, j) => stubs.has(String([i, j])))) return m;
    const content = m.content.map((b, j): ContentBlock => {
      const stub = stubs.get(String([i, j]));
      if (stub && b.type === 'tool_result') return { ...b, content: stub };
      if (
        narrate &&
        b.type === 'text' &&
        b.text.length >= MIN_NARRATION_CHARS &&
        !b.text.startsWith(PRUNED_PREFIX)
      ) {
        byRule.narration++;
        chars += b.text.length;
        return { ...b, text: narrationStub(b.text) };
      }
      return b;
    });
    return { ...m, content };
  });
  const pruned = Object.values(byRule).reduce((a, b) => a + b, 0);
  return { messages: pruned ? out : [...messages], pruned, chars, byRule };
}
