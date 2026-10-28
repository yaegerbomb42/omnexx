import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { globToRegExp } from '../security/glob.js';
import { isSecretPath } from '../security/paths.js';
import { formatHits, LIST_MAX, matchCounts } from './search-format.js';
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
  glob: z.string().optional().describe('File glob, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe('Directory to search'),
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
    '--null',
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
      if (re.test(l)) out.push(`${target}\0${i + 1}:${l.slice(0, 300)}`);
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
        if (re.test(l)) out.push(`${rel}\0${i + 1}:${l.slice(0, 300)}`);
      });
    }
  };
  await walk(dir);
  return out;
}

export const searchTool: Tool<typeof schema> = {
  name: 'search',
  description: `Regex search (ripgrep) over file contents, grouped by file; over ${LIST_MAX} files gives counts. Scope it with path and glob.`,
  schema,
  readOnly: true,
  concurrent: true,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const rest = { ...raw };
    delete rest.query;
    delete rest.regex;
    delete rest.dir;
    delete rest.directory;
    return {
      ...rest,
      pattern: raw.pattern ?? raw.query ?? raw.regex,
      path: raw.path ?? raw.dir ?? raw.directory,
    };
  },
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
    // Models often send code like `test(` meaning the literal text: search for it as written.
    let pattern = input.pattern;
    if (pattern.length > 500) {
      return fail('pattern is too long to search safely (max 500 characters)');
    }
    let literalNote = '';
    try {
      new RegExp(pattern);
    } catch {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      literalNote = `(not a valid regex, so searched for the literal text "${input.pattern}")\n`;
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
        (await viaRg(pattern, dir, input.glob, target, atHome)) ??
        (await viaJs(pattern, dir, input.glob, target));
      const counts = matchCounts(lines);
      if (!counts.size) return ok(`${literalNote}no matches`);
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const capped = [...counts].filter(([, n]) => n >= PER_FILE).map(([f]) => f);
      const perFile =
        capped.length && total <= LIST_MAX
          ? `\n(${capped.slice(0, 5).join(', ')} ${capped.length === 1 ? 'has' : 'have'} more than ${String(PER_FILE)} matches; search one with path set to it to see them all)`
          : '';
      return ok(literalNote + ctx.redactor.text(formatHits(lines)) + perFile);
    } catch (err) {
      return fail(`search failed: ${(err as Error).message}`);
    }
  },
};

export const _internal = { viaJs };
