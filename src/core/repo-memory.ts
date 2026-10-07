import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { git } from '../git/git.js';
import { readTextOr, writeJsonAtomic } from './atomic.js';
import { notesSchema, renderNotes, type Note } from './notes.js';
import type { OmnexxPaths } from './paths.js';
import { estimateTokens } from './tokens.js';

/**
 * Lessons about one repository that outlive any single run or chat: how to run things, env needs,
 * conventions, pitfalls. Keyed by the origin remote (clones share it), else by the repo path.
 */
export async function repoMemoryFile(paths: OmnexxPaths, repoRoot: string): Promise<string> {
  const remote = (
    await git(repoRoot, ['config', '--get', 'remote.origin.url'], { allowFailure: true })
  ).stdout.trim();
  const key = createHash('sha256')
    .update(remote || repoRoot)
    .digest('hex')
    .slice(0, 12);
  const slug =
    basename(repoRoot)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 40) || 'repo';
  return join(paths.home, 'repos', `${slug}-${key}`, 'notes.json');
}

export async function readRepoNotes(paths: OmnexxPaths, repoRoot: string): Promise<Note[]> {
  const raw = await readTextOr(await repoMemoryFile(paths, repoRoot), '[]');
  const parsed = notesSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Fold `notes` into the repo's lessons: new texts are added (renumbered), duplicates skipped,
 * and when over `maxTokens` the oldest lessons go first, env lessons last.
 */
export function mergeNotes(
  existing: readonly Note[],
  notes: readonly Note[],
  maxTokens: number,
): Note[] {
  const seen = new Set(existing.map((n) => norm(n.text)));
  let next = [...existing];
  let id = next.reduce((m, x) => Math.max(m, Number(x.id.slice(1))), 0);
  for (const n of notes) {
    if (seen.has(norm(n.text))) continue;
    seen.add(norm(n.text));
    next.push({ ...n, id: `N${++id}` });
  }
  const order = (n: Note): number => (n.type === 'env' ? 1 : 0);
  while (next.length > 1 && estimateTokens(renderNotes(next)) > maxTokens) {
    const victim = [...next].sort((a, b) => order(a) - order(b) || a.date.localeCompare(b.date))[0];
    next = next.filter((n) => n !== victim);
  }
  return next;
}

export async function saveToRepoMemory(
  paths: OmnexxPaths,
  repoRoot: string,
  notes: readonly Note[],
  maxTokens: number,
): Promise<number> {
  const file = await repoMemoryFile(paths, repoRoot);
  const existing = await readRepoNotes(paths, repoRoot);
  const merged = mergeNotes(existing, notes, maxTokens);
  await writeJsonAtomic(file, merged);
  return merged.length - existing.length;
}
