import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { globToRegExp } from '../security/glob.js';
import { isSecretPath } from '../security/paths.js';
import { fail, ok, type Tool } from './types.js';

export const MAX_HITS = 100;
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'target',
  '__pycache__',
  '.venv',
]);

const schema = z.strictObject({
  pattern: z
    .string()
    .describe('Regular expression (ripgrep syntax); empty lists the files instead'),
  glob: z.string().optional().describe('Only files matching this glob, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe('Directory to search, relative to the repo root'),
});

/**
 * Folders that are never what a search is looking for: dependencies, builds and caches anywhere,
 * plus, when the agent works in a home folder, the system and app folders in it.
 */
const NOISE_DIRS = [...SKIP_DIRS, '.cache', '.turbo', '.parcel-cache', 'vendor'];
const HOME_NOISE = [
  'Library',
  '.Trash',
  'Applications',
  'Pictures',
  'Movies',
  'Music',
  '.npm',
  '.npm-cache',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.config',
  '.local',
  '.vscode',
  '.cursor',
  '.docker',
  '.ollama',
];
/** Matches kept per file, so one huge file can't fill the result. */
const PER_FILE = 20;

function excludes(atHome: boolean): string[] {
  const dirs = atHome ? [...NOISE_DIRS, ...HOME_NOISE] : NOISE_DIRS;
  return dirs.flatMap((d) => ['--glob', `!**/${d}/**`]);
}

async function viaRg(
  pattern: string,
  dir: string,
  glob: string | undefined,
  target = '.',
  atHome = false,
): Promise<string[] | undefined> {
  const args = [
    '-n',
    '--with-filename',
    '--no-heading',
    '--color=never',
    '-C',
    '2',
    '--max-columns=300',
    '--glob',
    '!.git',
    '--glob',
    '!.env*',
    '--glob',
    '!*.pem',
    '--glob',
    '!*.key',
    '--max-count',
    String(PER_FILE),
    '--max-filesize',
    '2M',
    ...excludes(atHome),
  ];
  if (glob) args.push('--glob', glob);
  // Files it can't read (permission denied, a socket) are skipped, not fatal.
  args.push('--no-messages', '-e', pattern, target);
  const r = await execa('rg', args, { cwd: dir, reject: false, stdin: 'ignore', timeout: 60_000 });
  // Exit 2 with output: some files were unreadable, the rest searched fine.
  if (r.exitCode === 2 && r.stdout.trim()) return r.stdout.split('\n').filter(Boolean);
  if (r.failed && r.exitCode !== 1 && !(r.exitCode === 2 && !r.stderr.trim())) {
    if ((r as { code?: string }).code === 'ENOENT') return undefined;
    // execa leaves stderr undefined when the spawn itself fails (e.g. cwd is a file).
    const first = (r.stderr as string | undefined)?.split('\n')[0];
    if (first) throw new Error(first);
    throw new Error(r.message);
  }
  return r.stdout.split('\n').filter(Boolean);
}

/** Fallback when rg isn't installed: a bounded recursive scan. */
async function viaJs(
  pattern: string,
  dir: string,
  glob: string | undefined,
  target = '.',
): Promise<string[]> {
  const re = new RegExp(pattern);
  const globRe = glob ? globToRegExp(glob) : undefined;
  const out: string[] = [];
  if (target !== '.') {
    const lines = (await readFile(join(dir, target), 'utf8')).split('\n');
    lines.forEach((l, i) => {
      if (re.test(l)) out.push(`${target}:${i + 1}:${l.slice(0, 300)}`);
    });
    return out;
  }
  const walk = async (d: string): Promise<void> => {
    // Folders and files it can't read are skipped, like rg does.
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= MAX_HITS * 5) return;
      const abs = join(d, entry.name);
      const rel = relative(dir, abs);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
        continue;
      }
      if (!entry.isFile() || isSecretPath(rel) || (globRe && !globRe.test(rel))) continue;
      const size = await stat(abs).then(
        (st) => st.size,
        () => Infinity,
      );
      if (size > 2_000_000) continue;
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const lines = text.split('\n');
      lines.forEach((l, i) => {
        if (re.test(l)) out.push(`${rel}:${i + 1}:${l.slice(0, 300)}`);
      });
    }
  };
  await walk(dir);
  return out;
}

export const searchTool: Tool<typeof schema> = {
  name: 'search',
  description: `Search file contents with a regex (ripgrep). Returns up to ${MAX_HITS} matching lines with 2 lines of context (at most ${PER_FILE} per file). Scope it: pass path (a folder) and glob (e.g. "**/*.ts") whenever you know where to look; dependency, build and cache folders are skipped.`,
  schema,
  readOnly: true,
  concurrent: true,
  async run(input, ctx) {
    let dir: string;
    try {
      dir = ctx.jail.resolve(input.path ?? '.', 'read');
    } catch (err) {
      return fail(err instanceof OmnexxError ? err.message : String(err));
    }
    // Models send an empty pattern (or ".") when they mean "show me the files".
    if (!input.pattern.trim()) {
      const { listTree } = await import('./list.js');
      return ok(await listTree(dir, ctx.jail.resolve('.', 'read'), 3));
    }
    try {
      new RegExp(input.pattern);
    } catch {
      return fail(`invalid regex: ${input.pattern}`);
    }
    try {
      // A file as `path` (models do this often): search just that file, from its directory.
      let target = '.';
      if ((await stat(dir).catch(() => undefined))?.isFile()) {
        target = basename(dir);
        dir = dirname(dir);
      }
      const atHome = resolve(ctx.jail.root) === resolve(homedir());
      const lines =
        (await viaRg(input.pattern, dir, input.glob, target, atHome)) ??
        (await viaJs(input.pattern, dir, input.glob, target));
      const hits = lines.filter((l) => /^[^:]+:\d+:/.test(l));
      if (!hits.length) return ok('no matches');
      let shown = 0;
      const kept: string[] = [];
      for (const l of lines) {
        if (/^[^:]+:\d+:/.test(l)) shown++;
        if (shown > MAX_HITS) break;
        kept.push(l.replace(/^\.\//, ''));
      }
      const capped = cappedFiles(hits);
      const perFile = capped.length
        ? `\n(${capped.slice(0, 5).join(', ')} ${capped.length === 1 ? 'has' : 'have'} more than ${String(PER_FILE)} matches; search one with path set to it to see them all)`
        : '';
      const note =
        perFile +
        (hits.length > MAX_HITS
          ? `\n(${hits.length - MAX_HITS} more matches not shown. Most are in: ${whereMatches(hits)}. Narrow with path or glob.)`
          : '');
      return ok(ctx.redactor.text(kept.join('\n')) + note);
    } catch (err) {
      return fail(`search failed: ${(err as Error).message}`);
    }
  },
};

/** A match's folder, two levels deep at most ("src/api"), or "." for files at the top. */
function folderOf(parts: readonly string[]): string {
  if (parts.length > 2) return parts.slice(0, 2).join('/');
  if (parts.length === 2) return parts[0] ?? '.';
  return '.';
}

/** "src/api (40), web/pages (12)": where the matches are, by their first two folders. */
export function whereMatches(hits: readonly string[], top = 6): string {
  const counts = new Map<string, number>();
  for (const h of hits) {
    const file = h.replace(/^\.\//, '').split(':')[0] ?? '';
    const parts = file.split('/');
    const key = folderOf(parts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, n]) => `${k} (${String(n)})`)
    .join(', ');
}

/** Files that reached the per-file cap, so their remaining matches weren't returned. */
function cappedFiles(hits: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const h of hits) {
    const file = h.replace(/^\.\//, '').split(':')[0] ?? '';
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= PER_FILE).map(([f]) => f);
}

export const _internal = { viaJs };
