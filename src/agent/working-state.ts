import { CHARS_PER_TOKEN } from '../core/tokens.js';
import type { Message } from '../providers/types.js';
import type { CycleSummary } from './compaction.js';

/**
 * The Living State Frame (LSF, Slot 7) left in place of older turns after a fold:
 * - Sentinel-fenced verbatim analysis (immune to Markdown `## ` header injection)
 * - Priority-pinned doom-loop tombstones (never evicted by ordinary failed items)
 * - Mathematically bounded section budgets so the entire rendered LSF stays <= 2,400 tokens
 *   (9,600 chars), guaranteeing the 12-slot prompt never exceeds 10,240 tokens.
 *
 * Rendering is 100% deterministic and line-based so Slot 7 is byte-stable between folds.
 */

export const WORKING_STATE_HEADER = '# Working state (older turns folded into this)';
const ANALYSIS_HEADER = '## Your analysis (verbatim)';
const ANALYSIS_FENCE_START = '<!-- lsf:analysis:start -->';
const ANALYSIS_FENCE_END = '<!-- lsf:analysis:end -->';
const DONE = '## Done';
const DECISIONS = '## Decisions';
const FAILED = "## What didn't work (don't repeat)";
const OPEN = '## Open todos (your todo list; send the whole list again to update it):';
const FILES = '## Key files';
const IN_PROGRESS = '## In progress';
const LAST_ERROR = '## Last error';
const NEXT = '## Next step';

/** Hard token & character ceiling for Slot 7 (Living State Frame). */
export const LSF_SLOT_TOKEN_CAP = 2_400;
export const LSF_SLOT_CHAR_CAP = LSF_SLOT_TOKEN_CAP * CHARS_PER_TOKEN; // 9,600 chars

const MAX_DONE = 20;
const MAX_LIST = 15;
const MAX_FILES = 35;
const MAX_TODOS = 20;
const MAX_ANALYSIS_CHARS = 2_400;
const TOMBSTONE = '[harness] Rewound ';

const KNOWN_HEADERS = [
  ANALYSIS_HEADER,
  DONE,
  DECISIONS,
  FAILED,
  OPEN,
  FILES,
  IN_PROGRESS,
  LAST_ERROR,
  NEXT,
] as const;

const singleLine = (s: string): string => s.replace(/\s*\n+\s*/g, ' ').trim();

const bullets = (title: string, items: readonly string[]): string =>
  `${title}\n${items.map((i) => `- ${singleLine(i)}`).join('\n')}`;

export interface WorkingStateExtras {
  /** The think phase's analysis, kept word for word inside sentinel fences. */
  analysis?: string;
  /** Doom-loop tombstones, kept word for word and pinned above ordinary failures. */
  tombstones?: readonly string[];
  /** Optional custom char ceiling for Slot 7 (defaults to LSF_SLOT_CHAR_CAP = 9,600 chars). */
  maxChars?: number;
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const norm = singleLine(i);
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
}

/**
 * Separate doom-loop tombstones from ordinary failure notes so tombstones are never evicted
 * when `failed` is sliced to `MAX_LIST`.
 */
function mergeAndPinTombstones(
  tombstones: readonly string[],
  failed: readonly string[],
  maxItems: number,
): string[] {
  const all = dedupe([...tombstones, ...failed]);
  const pinned = all.filter((x) => x.startsWith(TOMBSTONE)).slice(-maxItems);
  const regular = all.filter((x) => !x.startsWith(TOMBSTONE));
  const remainingSlots = Math.max(0, maxItems - pinned.length);
  return [...pinned, ...regular.slice(-remainingSlots)];
}

/**
 * Proportionally shrink lower-priority lists (done, keyFiles, decisions) until the rendered LSF
 * fits strictly within `maxChars` (default 9,600 chars / 2,400 tokens).
 */
function assembleBoundedState(
  s: CycleSummary,
  analysis: string | undefined,
  mergedFailed: readonly string[],
  maxChars: number,
): string {
  let doneCap = Math.min(s.done.length, MAX_DONE);
  const filesSource = (s.keyFiles?.length ? s.keyFiles : s.filesTouched).slice(-MAX_FILES);
  let filesCap = filesSource.length;
  let decisionsCap = Math.min(s.decisions?.length ?? 0, MAX_LIST);
  let analysisCap = MAX_ANALYSIS_CHARS;

  const build = (): string => {
    const parts = [WORKING_STATE_HEADER];
    if (analysis && analysisCap > 0) {
      const clipped = analysis.slice(0, analysisCap);
      parts.push(`${ANALYSIS_HEADER}\n${ANALYSIS_FENCE_START}\n${clipped}\n${ANALYSIS_FENCE_END}`);
    }
    if (doneCap > 0) parts.push(bullets(DONE, s.done.slice(-doneCap)));
    if (decisionsCap > 0 && s.decisions?.length) {
      parts.push(bullets(DECISIONS, s.decisions.slice(-decisionsCap)));
    }
    if (mergedFailed.length) parts.push(bullets(FAILED, mergedFailed));
    if (s.openTodos?.length) parts.push(bullets(OPEN, s.openTodos.slice(0, MAX_TODOS)));
    if (filesCap > 0) parts.push(bullets(FILES, filesSource.slice(-filesCap)));
    parts.push(`${IN_PROGRESS}\n${singleLine(s.inProgress).slice(0, 600)}`);
    if (s.lastError) parts.push(`${LAST_ERROR}\n${singleLine(s.lastError).slice(0, 800)}`);
    parts.push(`${NEXT}\n${singleLine(s.nextStep).slice(0, 600)}`);
    return parts.join('\n\n');
  };

  let rendered = build();
  // Water-filling compaction loop: shed oldest `done`, then `files`, then `analysis`, then `decisions`.
  while (rendered.length > maxChars) {
    if (doneCap > 5) {
      doneCap = Math.max(5, Math.floor(doneCap * 0.7));
    } else if (filesCap > 8) {
      filesCap = Math.max(8, Math.floor(filesCap * 0.7));
    } else if (analysis && analysisCap > 600) {
      analysisCap = Math.max(600, Math.floor(analysisCap * 0.7));
    } else if (decisionsCap > 4) {
      decisionsCap = Math.max(4, Math.floor(decisionsCap * 0.7));
    } else if (doneCap > 1) {
      doneCap--;
    } else if (filesCap > 1) {
      filesCap--;
    } else {
      rendered = rendered.slice(0, maxChars);
      break;
    }
    rendered = build();
  }
  return rendered;
}

export function renderWorkingState(s: CycleSummary, extras: WorkingStateExtras = {}): string {
  const maxChars = extras.maxChars ?? LSF_SLOT_CHAR_CAP;
  const cleanAnalysis = extras.analysis
    ?.trim()
    .replaceAll(ANALYSIS_FENCE_START, '')
    .replaceAll(ANALYSIS_FENCE_END, '');
  const mergedFailed = mergeAndPinTombstones(extras.tombstones ?? [], s.failed ?? [], MAX_LIST);
  return assembleBoundedState(s, cleanAnalysis, mergedFailed, maxChars);
}

/**
 * Strip the sentinel-fenced analysis block before scanning for `## ` section headers so
 * headings inside the user/think analysis never corrupt `parseWorkingState`.
 */
function stripFencedAnalysis(text: string): string {
  const start = text.indexOf(ANALYSIS_FENCE_START);
  const end = text.indexOf(ANALYSIS_FENCE_END);
  if (start >= 0 && end > start) {
    return text.slice(0, start) + text.slice(end + ANALYSIS_FENCE_END.length);
  }
  return text;
}

function section(text: string, title: string): string | undefined {
  const safeText = title === ANALYSIS_HEADER ? text : stripFencedAnalysis(text);
  const marker = `${title}\n`;
  const start = safeText.indexOf(marker);
  if (start < 0) return undefined;
  const body = safeText.slice(start + marker.length);

  // Find the earliest known LSF section boundary rather than any arbitrary `\n\n## `
  let earliestEnd = body.length;
  for (const h of KNOWN_HEADERS) {
    if (h === title) continue;
    const idx = body.indexOf(`\n\n${h}\n`);
    if (idx >= 0 && idx < earliestEnd) earliestEnd = idx;
  }
  return body.slice(0, earliestEnd).trim();
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
  const inProgress = section(t, IN_PROGRESS);
  const nextStep = section(t, NEXT);

  // If the block only holds the initial seed header without structured fold sections yet:
  if (inProgress === undefined && nextStep === undefined && !keyFiles.length && !failed.length) {
    return undefined;
  }

  return {
    done: listIn(t, DONE),
    inProgress: inProgress ?? '',
    filesTouched: [],
    nextStep: nextStep ?? '',
    ...(keyFiles.length ? { keyFiles } : {}),
    ...(lastError ? { lastError } : {}),
    ...(todos.length ? { openTodos: todos } : {}),
    ...(decisions.length ? { decisions } : {}),
    ...(failed.length ? { failed } : {}),
  };
}

/** The analysis a rendered state holds, if any (carried verbatim into the next fold). */
export function analysisIn(text: string): string | undefined {
  const at = text.indexOf(WORKING_STATE_HEADER);
  if (at < 0) return undefined;
  const sub = text.slice(at);
  const fStart = sub.indexOf(ANALYSIS_FENCE_START);
  const fEnd = sub.indexOf(ANALYSIS_FENCE_END);
  if (fStart >= 0 && fEnd > fStart) {
    return sub.slice(fStart + ANALYSIS_FENCE_START.length, fEnd).trim() || undefined;
  }
  return section(sub, ANALYSIS_HEADER);
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
 * kept when capped, with doom-loop tombstones pinned); where the work stands comes from `next`.
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
  const priorTombstones = (prior.failed ?? []).filter((f) => f.startsWith(TOMBSTONE));
  const failed = mergeAndPinTombstones(
    priorTombstones,
    [...(prior.failed ?? []), ...(next.failed ?? [])],
    MAX_LIST,
  );
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
  return dedupe(
    messages.flatMap((m) =>
      m.content.flatMap((b) =>
        b.type === 'text' && b.text.startsWith(TOMBSTONE)
          ? [b.text.split('\n\n')[0] ?? b.text]
          : [],
      ),
    ),
  );
}

export interface WorkingStateDiff {
  addedDone: readonly string[];
  addedDecisions: readonly string[];
  addedFailed: readonly string[];
  inProgressChanged: boolean;
  nextStepChanged: boolean;
  newTodos: readonly string[];
}

/**
 * Computes the delta between two working states so cycles can communicate changes
 * without retransmitting unchanged historical state.
 */
export function diffWorkingState(
  prior: CycleSummary | undefined,
  current: CycleSummary,
): WorkingStateDiff {
  if (!prior) {
    return {
      addedDone: current.done,
      addedDecisions: current.decisions ?? [],
      addedFailed: current.failed ?? [],
      inProgressChanged: Boolean(current.inProgress),
      nextStepChanged: Boolean(current.nextStep),
      newTodos: current.openTodos ?? [],
    };
  }
  const priorDone = new Set(prior.done);
  const priorDec = new Set(prior.decisions ?? []);
  const priorFailed = new Set(prior.failed ?? []);

  return {
    addedDone: current.done.filter((d) => !priorDone.has(d)),
    addedDecisions: (current.decisions ?? []).filter((d) => !priorDec.has(d)),
    addedFailed: (current.failed ?? []).filter((f) => !priorFailed.has(f)),
    inProgressChanged: current.inProgress !== prior.inProgress,
    nextStepChanged: current.nextStep !== prior.nextStep,
    newTodos: current.openTodos ?? [],
  };
}
