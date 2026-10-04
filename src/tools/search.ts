import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { globToRegExp } from '../security/glob.js';
import { isSecretPath } from '../security/paths.js';
import { fail, ok, type Tool } from './types.js';

export const MAX_HITS = 100;
const SKIP_DIRS = new Set([
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
  pattern: z.string().min(1).describe('Regular expression (ripgrep syntax)'),
  glob: z.string().optional().describe('Only files matching this glob, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe('Directory to search, relative to the repo root'),
});

async function viaRg(
  pattern: string,
  dir: string,
  glob: string | undefined,
): Promise<string[] | undefined> {
  const args = [
    '-n',
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
  ];
  if (glob) args.push('--glob', glob);
  args.push('-e', pattern, '.');
  const r = await execa('rg', args, { cwd: dir, reject: false, stdin: 'ignore', timeout: 60_000 });
  if (r.failed && r.exitCode !== 1) {
    if ((r as { code?: string }).code === 'ENOENT') return undefined;
    throw new Error(r.stderr.split('\n')[0] ?? 'rg failed');
  }
  return r.stdout.split('\n').filter(Boolean);
}

/** Fallback when rg isn't installed: a bounded recursive scan. */
async function viaJs(pattern: string, dir: string, glob: string | undefined): Promise<string[]> {
  const re = new RegExp(pattern);
  const globRe = glob ? globToRegExp(glob) : undefined;
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (out.length >= MAX_HITS * 5) return;
      const abs = join(d, entry.name);
      const rel = relative(dir, abs);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
        continue;
      }
      if (!entry.isFile() || isSecretPath(rel) || (globRe && !globRe.test(rel))) continue;
      if ((await stat(abs)).size > 2_000_000) continue;
      const lines = (await readFile(abs, 'utf8')).split('\n');
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
  description: `Search file contents with a regex (ripgrep). Returns up to ${MAX_HITS} matching lines with 2 lines of context.`,
  schema,
  readOnly: true,
  async run(input, ctx) {
    let dir: string;
    try {
      dir = ctx.jail.resolve(input.path ?? '.', 'read');
    } catch (err) {
      return fail(err instanceof OmnexxError ? err.message : String(err));
    }
    try {
      new RegExp(input.pattern);
    } catch {
      return fail(`invalid regex: ${input.pattern}`);
    }
    try {
      const lines =
        (await viaRg(input.pattern, dir, input.glob)) ??
        (await viaJs(input.pattern, dir, input.glob));
      const hits = lines.filter((l) => /^[^:]+:\d+:/.test(l));
      if (!hits.length) return ok('no matches');
      let shown = 0;
      const kept: string[] = [];
      for (const l of lines) {
        if (/^[^:]+:\d+:/.test(l)) shown++;
        if (shown > MAX_HITS) break;
        kept.push(l.replace(/^\.\//, ''));
      }
      const note =
        hits.length > MAX_HITS
          ? `\n(${hits.length - MAX_HITS} more matches not shown; narrow the pattern or glob)`
          : '';
      return ok(ctx.redactor.text(kept.join('\n')) + note);
    } catch (err) {
      return fail(`search failed: ${(err as Error).message}`);
    }
  },
};

export const _internal = { viaJs };
