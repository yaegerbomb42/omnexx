import { dirname, join } from 'node:path';
import { readTextOr, writeFileAtomic } from '../core/atomic.js';
import { renderNotes } from '../core/notes.js';
import { readRepoNotes, repoMemoryFile } from '../core/repo-memory.js';
import type { RunStore } from '../core/run-store.js';
import type { RunningContext } from '../core/running-context.js';
import { git } from '../git/git.js';
import { codemapSchema, renderCodemap } from './codemap.js';
import { readIntent } from './intent.js';

/**
 * Context scopes, widest to narrowest. Each one is a capped view the agent pulls in when it
 * wants it, plus a notes section the agent rewrites itself, so long work keeps its bearings
 * without paying for every level on every turn.
 */
export const SCOPES = ['general', 'repo', 'heat', 'recent'] as const;
export type Scope = (typeof SCOPES)[number];

/** Token caps per scope (about 4 characters a token). */
export const SCOPE_MAX_TOKENS: Record<Scope, number> = {
  general: 8_000,
  repo: 16_000,
  heat: 4_000,
  recent: 8_000,
};
const CHARS_PER_TOKEN = 4;
/** The agent's own notes in a scope may use at most this share of the scope's cap. */
const NOTES_SHARE = 0.25;
const HEAT_COMMITS = 200;
const HEAT_FILES = 30;

/** General and repo notes outlive the run (kept per repository); heat and recent belong to it. */
const PERSISTENT: ReadonlySet<Scope> = new Set(['general', 'repo']);

export interface ScopeEnv {
  store: RunStore;
  repoRoot: string;
  runningContext?: RunningContext;
  /** Files edited in this context. */
  edited?: ReadonlySet<string>;
}

export const notesCap = (scope: Scope): number =>
  Math.floor(SCOPE_MAX_TOKENS[scope] * CHARS_PER_TOKEN * NOTES_SHARE);

async function notesFile(env: ScopeEnv, scope: Scope): Promise<string> {
  if (!PERSISTENT.has(scope)) return env.store.file(join('scopes', `${scope}.md`));
  const repoDir = dirname(await repoMemoryFile({ home: env.store.home }, env.repoRoot));
  return join(repoDir, 'scopes', `${scope}.md`);
}

export async function readScopeNotes(env: ScopeEnv, scope: Scope): Promise<string> {
  return (await readTextOr(await notesFile(env, scope), '')).trim();
}

/** Replace the agent's notes in a scope. Returns the stored text (clipped to the cap). */
export async function writeScopeNotes(env: ScopeEnv, scope: Scope, text: string): Promise<string> {
  const clipped = text.trim().slice(0, notesCap(scope));
  await writeFileAtomic(await notesFile(env, scope), `${clipped}\n`);
  return clipped;
}

/** Files ranked by how often they changed lately: recent commits, uncommitted work, this context's edits. */
export async function heatmap(
  repoRoot: string,
  edited: ReadonlySet<string> = new Set(),
): Promise<string> {
  const counts = new Map<string, number>();
  const bump = (f: string, by: number) => counts.set(f, (counts.get(f) ?? 0) + by);
  const log = await git(repoRoot, ['log', '-n', String(HEAT_COMMITS), '--name-only', '--format='], {
    allowFailure: true,
  });
  for (const f of log.stdout.split('\n')) if (f.trim()) bump(f.trim(), 1);
  const status = await git(repoRoot, ['status', '--porcelain'], { allowFailure: true });
  const dirty = status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  for (const f of dirty) bump(f, 5);
  for (const f of edited) bump(f, 10);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, HEAT_FILES);
  if (!ranked.length) return 'no history yet';
  const marks = (f: string) =>
    [edited.has(f) ? 'edited here' : '', dirty.includes(f) ? 'uncommitted' : ''].filter(Boolean);
  return ranked
    .map(([f, n]) => `${f}  ${n}${marks(f).length ? ` (${marks(f).join(', ')})` : ''}`)
    .join('\n');
}

async function generalView(env: ScopeEnv): Promise<string> {
  const goal = await env.store.readGoal().then(
    (g) => g.text.trim(),
    () => '',
  );
  const intent = await readIntent(env.store).catch(() => '');
  const lessons = renderNotes(await readRepoNotes({ home: env.store.home }, env.repoRoot));
  return [
    goal ? `## Goal\n${goal}` : '',
    intent,
    lessons ? `## Lessons about this repo\n${lessons}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function repoView(env: ScopeEnv): Promise<string> {
  const raw = await readTextOr(env.store.file('codemap.json'), '');
  const parsed = raw ? codemapSchema.safeParse(JSON.parse(raw)) : undefined;
  if (parsed?.success) return renderCodemap(parsed.data, SCOPE_MAX_TOKENS.repo * (1 - NOTES_SHARE));
  const files = await git(env.repoRoot, ['ls-files'], { allowFailure: true });
  return `## Tracked files\n${files.stdout}`;
}

async function builtIn(env: ScopeEnv, scope: Scope): Promise<string> {
  switch (scope) {
    case 'general':
      return generalView(env);
    case 'repo':
      return repoView(env);
    case 'heat':
      return `## Hot files (recent changes)\n${await heatmap(env.repoRoot, env.edited)}`;
    case 'recent':
      return (await env.runningContext?.forPrompt()) ?? '';
  }
}

/** One scope as the model sees it: the built-in view plus the agent's notes, within the cap. */
export async function renderScope(env: ScopeEnv, scope: Scope): Promise<string> {
  const notes = await readScopeNotes(env, scope);
  const cap = SCOPE_MAX_TOKENS[scope] * CHARS_PER_TOKEN;
  const notesBlock = notes ? `## Your ${scope} notes\n${notes}` : '';
  const room = Math.max(0, cap - notesBlock.length - 2);
  let view = (await builtIn(env, scope)).trim();
  if (view.length > room) view = `${view.slice(0, room)}\n… (clipped to the ${scope} cap)`;
  return [notesBlock, view].filter(Boolean).join('\n\n') || `the ${scope} scope is empty`;
}
