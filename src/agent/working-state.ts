import type { Message } from '../providers/types.js';
import type { CycleSummary } from './compaction.js';

/**
 * The working state a fold leaves in place of the older turns: goal (the first message, kept
 * as is), the agent's analysis verbatim, done steps, decisions and what didn't work (the
 * doom-loop breaker's tombstones verbatim), open items, key files and where the work stands.
 * Verified facts stay in their own system block and are never folded.
 *
 * Rendering is deterministic and line-based so the block is byte-stable between folds (it sits
 * in the cached prefix) and can be read back: the next fold merges with it instead of
 * re-summarizing a summary.
 */

export const WORKING_STATE_HEADER = '# Working state (older turns folded into this)';
const ANALYSIS_HEADER = '## Your analysis (verbatim)';
const DONE = '## Done';
const DECISIONS = '## Decisions';
const FAILED = "## What didn't work (don't repeat)";
const OPEN = '## Open todos (your todo list; send the whole list again to update it):';
const FILES = '## Key files';
const IN_PROGRESS = '## In progress';
const LAST_ERROR = '## Last error';
const NEXT = '## Next step';

const MAX_DONE = 30;
const MAX_LIST = 20;
const MAX_FILES = 60;
const MAX_ANALYSIS_CHARS = 12_000;
const TOMBSTONE = '[harness] Rewound ';

const bullets = (title: string, items: readonly string[]): string =>
  `${title}\n${items.map((i) => `- ${i.replace(/\n+/g, ' ')}`).join('\n')}`;

export interface WorkingStateExtras {
  /** The think phase's analysis, kept word for word. */
  analysis?: string;
  /** Doom-loop tombstones, kept word for word. */
  tombstones?: readonly string[];
}

export function renderWorkingState(s: CycleSummary, extras: WorkingStateExtras = {}): string {
  const parts = [WORKING_STATE_HEADER];
  const analysis = extras.analysis?.trim();
  if (analysis) parts.push(`${ANALYSIS_HEADER}\n${analysis.slice(0, MAX_ANALYSIS_CHARS)}`);
  if (s.done.length) parts.push(bullets(DONE, s.done));
  if (s.decisions?.length) parts.push(bullets(DECISIONS, s.decisions));
  const failed = [...(extras.tombstones ?? []), ...(s.failed ?? [])];
  if (failed.length) parts.push(bullets(FAILED, dedupe(failed).slice(-MAX_LIST)));
  if (s.openTodos?.length) parts.push(bullets(OPEN, s.openTodos));
  const files = s.keyFiles?.length ? s.keyFiles : s.filesTouched;
  if (files.length) parts.push(bullets(FILES, files));
  parts.push(`${IN_PROGRESS}\n${s.inProgress.replace(/\n+/g, ' ')}`);
  if (s.lastError) parts.push(`${LAST_ERROR}\n${s.lastError.replace(/\n+/g, ' ')}`);
  parts.push(`${NEXT}\n${s.nextStep.replace(/\n+/g, ' ')}`);
  return parts.join('\n\n');
}

function section(text: string, title: string): string | undefined {
  const start = text.indexOf(`${title}\n`);
  if (start < 0) return undefined;
  const body = text.slice(start + title.length + 1);
  const end = body.search(/\n\n## /);
  return end < 0 ? body : body.slice(0, end);
}

const listIn = (text: string, title: string): string[] =>
  (section(text, title) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));

/** Read a rendered working state back; undefined when `text` holds none. */
export function parseWorkingState(text: string): CycleSummary | undefined {
  const at = text.indexOf(WORKING_STATE_HEADER);
  if (at < 0) return undefined;
  const t = text.slice(at);
  const keyFiles = listIn(t, FILES);
  const lastError = section(t, LAST_ERROR);
  const todos = listIn(t, OPEN);
  const decisions = listIn(t, DECISIONS);
  const failed = listIn(t, FAILED);
  return {
    done: listIn(t, DONE),
    inProgress: section(t, IN_PROGRESS) ?? '',
    filesTouched: [],
    nextStep: section(t, NEXT) ?? '',
    ...(keyFiles.length ? { keyFiles } : {}),
    ...(lastError ? { lastError } : {}),
    ...(todos.length ? { openTodos: todos } : {}),
    ...(decisions.length ? { decisions } : {}),
    ...(failed.length ? { failed } : {}),
  };
}

/** The analysis a rendered state holds, if any (it is carried verbatim into the next fold). */
export function analysisIn(text: string): string | undefined {
  return section(text.slice(Math.max(0, text.indexOf(WORKING_STATE_HEADER))), ANALYSIS_HEADER);
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
}

const fileKey = (entry: string): string => entry.split(/\s+[—:-]\s+/)[0]?.trim() ?? entry;

/** Key files merged by path: the newer note for a path wins, order of first mention kept. */
function mergeFiles(prior: readonly string[], next: readonly string[]): string[] {
  const byPath = new Map<string, string>();
  for (const f of [...prior, ...next]) byPath.set(fileKey(f), f);
  return [...byPath.values()].slice(-MAX_FILES);
}

/**
 * Merge the previous working state with the fold of the turns since. Lists accumulate (newest
 * kept when capped); where the work stands comes from the newer fold.
 */
export function mergeWorkingState(
  prior: CycleSummary | undefined,
  next: CycleSummary,
): CycleSummary {
  if (!prior) return next;
  const keyFiles = mergeFiles(
    prior.keyFiles ?? prior.filesTouched,
    next.keyFiles ?? next.filesTouched,
  );
  const decisions = dedupe([...(prior.decisions ?? []), ...(next.decisions ?? [])]).slice(
    -MAX_LIST,
  );
  const failed = dedupe([...(prior.failed ?? []), ...(next.failed ?? [])]).slice(-MAX_LIST);
  const lastError = next.lastError ?? prior.lastError;
  const todos = next.openTodos ?? prior.openTodos;
  return {
    done: dedupe([...prior.done, ...next.done]).slice(-MAX_DONE),
    inProgress: next.inProgress || prior.inProgress,
    filesTouched: dedupe([...prior.filesTouched, ...next.filesTouched]).slice(-MAX_FILES),
    nextStep: next.nextStep || prior.nextStep,
    ...(keyFiles.length ? { keyFiles } : {}),
    ...(decisions.length ? { decisions } : {}),
    ...(failed.length ? { failed } : {}),
    ...(lastError ? { lastError } : {}),
    ...(todos?.length ? { openTodos: todos } : {}),
  };
}

/** The doom-loop breaker's tombstones in `messages`, word for word. */
export function tombstonesIn(messages: readonly Message[]): string[] {
  return messages.flatMap((m) =>
    m.content.flatMap((b) =>
      b.type === 'text' && b.text.startsWith(TOMBSTONE) ? [b.text.split('\n\n')[0] ?? b.text] : [],
    ),
  );
}
