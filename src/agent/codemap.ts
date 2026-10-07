import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { estimateTokens } from '../core/tokens.js';
import { git } from '../git/git.js';
import { matchesAny } from '../security/glob.js';
import { isSecretPath } from '../security/paths.js';
import { extractSymbols } from '../tools/outline.js';
import { TEST_FILE_PATTERNS } from '../verify/anticheat.js';

/**
 * The codebase map (plan §14.2): one entry per tracked file with its key symbols and, when
 * available, a one-line purpose. Built once, then updated only for files each accepted commit
 * touched, so untouched entries stay byte-identical and the cached prefix stays stable.
 */
export const codemapEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(['source', 'test', 'config', 'doc', 'other']),
  lines: z.number(),
  symbols: z.array(z.string()),
  purpose: z.string().optional(),
});
export type CodemapEntry = z.infer<typeof codemapEntrySchema>;
export const codemapSchema = z.object({
  version: z.literal(1),
  entries: z.array(codemapEntrySchema),
});
export type Codemap = z.infer<typeof codemapSchema>;

const SKIP = [
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  '*.min.js',
  '*.map',
  '*.snap',
  '*.svg',
  '*.png',
  '*.jpg',
  '*.gif',
  '*.ico',
  '*.woff*',
  '*.pdf',
];
const MAX_FILE_BYTES = 1_000_000;
const MAX_SYMBOLS = 8;

function kindOf(path: string): CodemapEntry['kind'] {
  if (matchesAny(path, TEST_FILE_PATTERNS)) return 'test';
  if (/\.(md|mdx|rst|txt)$/i.test(path)) return 'doc';
  if (/\.(json|ya?ml|toml|ini|cfg|conf)$|(^|\/)(Makefile|Dockerfile|\.[a-z]+rc)$/i.test(path))
    return 'config';
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|sh)$/i.test(
      path,
    )
  )
    return 'source';
  return 'other';
}

async function entryFor(root: string, path: string): Promise<CodemapEntry | undefined> {
  if (isSecretPath(path) || matchesAny(path, SKIP)) return undefined;
  try {
    const abs = join(root, path);
    if ((await stat(abs)).size > MAX_FILE_BYTES) return undefined;
    const text = await readFile(abs, 'utf8');
    if (text.includes('\0')) return undefined;
    const kind = kindOf(path);
    const symbols =
      kind === 'source'
        ? extractSymbols(text)
            .slice(0, MAX_SYMBOLS)
            .map((s) => `${s.kind} ${s.name}`)
        : [];
    return { path, kind, lines: text.split('\n').length, symbols };
  } catch {
    return undefined;
  }
}

/** Directories a walk outside git never descends into. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '__pycache__',
  'venv',
  'Library',
  'Applications',
]);
const WALK_MAX_FILES = 2_000;
const WALK_MAX_DEPTH = 4;

/**
 * Outside a git repository (chat in any folder), a bounded walk: no hidden or dependency
 * directories, a few levels deep, at most a couple thousand files, so a home folder stays cheap.
 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= WALK_MAX_FILES || depth > WALK_MAX_DEPTH) return;
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= WALK_MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(rel, depth + 1);
      else if (e.isFile()) out.push(rel);
    }
  };
  await visit('', 0);
  return out;
}

export async function trackedFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z'], { allowFailure: true });
  const files = out.exitCode === 0 ? out.stdout.split('\0').filter(Boolean) : await walkFiles(root);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function buildCodemap(root: string): Promise<Codemap> {
  const entries: CodemapEntry[] = [];
  for (const path of await trackedFiles(root)) {
    const e = await entryFor(root, path);
    if (e) entries.push(e);
  }
  return { version: 1, entries };
}

/**
 * Recompute entries only for `changed` paths (added, modified or deleted). A changed file keeps
 * its purpose unless `purposes` supplies a new one. Returns the paths that are new or changed.
 */
export async function updateCodemap(
  map: Codemap,
  root: string,
  changed: readonly string[],
): Promise<{ map: Codemap; touched: string[] }> {
  const byPath = new Map(map.entries.map((e) => [e.path, e]));
  const touched: string[] = [];
  for (const path of new Set(changed)) {
    const fresh = await entryFor(root, path);
    const old = byPath.get(path);
    if (!fresh) {
      byPath.delete(path);
      continue;
    }
    const next =
      old?.purpose && old.symbols.join() === fresh.symbols.join()
        ? { ...fresh, purpose: old.purpose }
        : fresh;
    byPath.set(path, next);
    touched.push(path);
  }
  // Bytewise, same order as `git ls-files`, so an update never reorders untouched entries.
  const entries = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { map: { version: 1, entries }, touched };
}

export function setPurposes(map: Codemap, purposes: Record<string, string>): Codemap {
  return {
    version: 1,
    entries: map.entries.map((e) =>
      purposes[e.path] ? { ...e, purpose: purposes[e.path]?.slice(0, 160) } : e,
    ),
  };
}

function line(e: CodemapEntry, withSymbols: boolean): string {
  const syms = withSymbols && e.symbols.length ? `: ${e.symbols.join(', ')}` : '';
  const purpose = e.purpose ? ` — ${e.purpose}` : '';
  return `${e.path} (${e.lines})${purpose}${syms}`;
}

/**
 * Render under `maxTokens`. Degrades deterministically: full lines → no symbols for tests and
 * config → no symbols at all → whole directories collapsed to "dir/ (N files)".
 */
export function renderCodemap(map: Codemap, maxTokens: number): string {
  const header = '# Codebase map (path (lines) — purpose: symbols)';
  const attempts: ((e: CodemapEntry) => string)[] = [
    (e) => line(e, true),
    (e) => line(e, e.kind === 'source'),
    (e) => line(e, false),
  ];
  for (const fmt of attempts) {
    const text = [header, ...map.entries.map(fmt)].join('\n');
    if (estimateTokens(text) <= maxTokens) return text;
  }
  // Collapse deepest directories first until it fits.
  interface Group {
    key: string;
    count: number;
    entry: CodemapEntry | undefined;
  }
  let groups: Group[] = map.entries.map((e) => ({ key: e.path, count: 1, entry: e }));
  for (let depth = 6; depth >= 0; depth--) {
    const merged = new Map<
      string,
      { key: string; count: number; entry: CodemapEntry | undefined }
    >();
    for (const g of groups) {
      const parts = g.key.split('/');
      const key = parts.length - 1 > depth ? `${parts.slice(0, depth + 1).join('/')}/` : g.key;
      const prev = merged.get(key);
      merged.set(
        key,
        prev
          ? { key, count: prev.count + g.count, entry: undefined }
          : { ...g, key, entry: key === g.key ? g.entry : undefined },
      );
    }
    groups = [...merged.values()];
    const text = [
      header,
      ...groups.map((g) =>
        g.entry && g.count === 1 ? line(g.entry, false) : `${g.key} (${g.count} files)`,
      ),
    ].join('\n');
    if (estimateTokens(text) <= maxTokens) return text;
  }
  const dirs = new Set(map.entries.map((e) => dirname(e.path).split('/')[0] ?? '.'));
  return [
    header,
    `${map.entries.length} files in ${dirs.size} top-level directories (map too large to show)`,
  ].join('\n');
}
