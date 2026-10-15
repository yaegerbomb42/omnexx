import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { OmnexxError } from '../errors.js';
import type { ToolContext } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.omnexx',
  '.venv',
]);
/** Stop walking after this many files: suggestions are a courtesy, not a search. */
const MAX_FILES = 5_000;
const MAX_SUGGESTIONS = 3;

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length && out.length < MAX_FILES) {
    const dir = queue.shift() ?? root;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(join(dir, e.name));
      } else if (e.isFile()) out.push(relative(root, join(dir, e.name)));
    }
  }
  return out;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** Up to three repo files close to the missing `path`: same file name first, then by edit distance. */
export async function closeMatches(root: string, path: string): Promise<string[]> {
  const want = path.replace(/^\.\//, '');
  const name = basename(want).toLowerCase();
  const limit = Math.max(3, Math.floor(want.length / 3));
  return (await walk(root))
    .map((f) => {
      const d = distance(f.toLowerCase(), want.toLowerCase());
      return { f, score: basename(f).toLowerCase() === name ? d / 100 : d };
    })
    .filter((c) => c.score <= limit)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => c.f);
}

/** " Did you mean a or b?" for a missing file, or "" when nothing is close. */
export async function didYouMean(root: string, path: string): Promise<string> {
  const hits = await closeMatches(root, path);
  return hits.length ? ` Did you mean ${hits.join(' or ')}?` : '';
}

/** The message for a file that cannot be opened: jail refusals as-is, missing files with close matches. */
export async function openError(
  ctx: ToolContext,
  path: string,
  err: unknown,
  hint = '',
  verb = 'open',
): Promise<string> {
  if (err instanceof OmnexxError) return err.message;
  const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  const near = code === 'ENOENT' ? await didYouMean(ctx.jail.root, path) : '';
  return `cannot ${verb} ${path}: ${code}.${near}${hint ? ` ${hint}` : ''}`;
}
