import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { runShell } from '../core/exec.js';
import { checkTs, TS_EXTENSIONS, type Diag } from './ts-check.js';
import type { ToolContext } from './types.js';

/** A formatter that takes longer than this is abandoned; the edit stands unformatted. */
export const FORMAT_TIMEOUT_MS = 2_000;
/** Diagnostics slower than this are skipped silently. */
export const DIAG_TIMEOUT_MS = 1_500;
/** At most this many new problems are listed in an edit result. */
const MAX_DIAGS = 3;
const MAX_DIAG_CHARS = 160;

const PRETTIER_EXT = /\.(?:[cm]?[jt]sx?|json|css|scss|less|md|ya?ml|html|vue)$/;
const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];

export interface PostEditOptions {
  formatTimeoutMs?: number;
  diagTimeoutMs?: number;
}

/** Formatter and checks run repo code on the host: only when tools run on the host, not in a sandbox. */
function onHost(ctx: ToolContext): boolean {
  return ctx.exec === undefined || ctx.exec === runShell;
}

function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  input?: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, env }, (err, _out, stderr) => {
      resolve({ ok: !err, stderr });
    });
    child.on('error', () => {
      resolve({ ok: false, stderr: '' });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

function hasPrettierConfig(root: string): boolean {
  if (PRETTIER_CONFIGS.some((f) => existsSync(join(root, f)))) return true;
  try {
    return 'prettier' in (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as object);
  } catch {
    return false; // no or unparsable package.json: no config there
  }
}

function hasRuffConfig(root: string): boolean {
  if (existsSync(join(root, 'ruff.toml')) || existsSync(join(root, '.ruff.toml'))) return true;
  try {
    return readFileSync(join(root, 'pyproject.toml'), 'utf8').includes('[tool.ruff');
  } catch {
    return false;
  }
}

/** The project's formatter for this file, if one is configured: [command, args]. */
export function formatterFor(root: string, abs: string): [string, string[]] | undefined {
  const prettier = join(root, 'node_modules', '.bin', 'prettier');
  if (PRETTIER_EXT.test(abs) && existsSync(prettier) && hasPrettierConfig(root))
    return [prettier, ['--write', '--log-level=warn', abs]];
  if (extname(abs) === '.py' && hasRuffConfig(root)) return ['ruff', ['format', '--quiet', abs]];
  if (extname(abs) === '.go') return ['gofmt', ['-w', abs]];
  return undefined;
}

const PY_CHECK = `import ast,sys
try:
    ast.parse(sys.stdin.read())
except SyntaxError as e:
    print(f"{e.lineno or 0}\\t{e.msg}", file=sys.stderr); sys.exit(1)`;

async function pythonSyntax(root: string, text: string, ms: number, env: Record<string, string>) {
  const r = await run('python3', ['-c', PY_CHECK], root, ms, env, text);
  if (r.ok) return [];
  const m = /^(\d+)\t(.+)$/m.exec(r.stderr);
  return m ? [{ line: Number(m[1]), code: 'SyntaxError', message: m[2] ?? '' }] : [];
}

const key = (d: Diag): string => `${d.code} ${d.message}`;

/** The problems in `after` that `before` did not have (by code and message). */
export function newDiags(before: readonly Diag[], after: readonly Diag[]): Diag[] {
  const seen = new Map<string, number>();
  for (const d of before) seen.set(key(d), (seen.get(key(d)) ?? 0) + 1);
  return after.filter((d) => {
    const n = seen.get(key(d)) ?? 0;
    if (n > 0) seen.set(key(d), n - 1);
    return n === 0;
  });
}

export function renderDiags(diags: readonly Diag[]): string {
  if (!diags.length) return '';
  const rows = diags.slice(0, MAX_DIAGS).map((d) => {
    const row = `⚠ line ${d.line}: ${d.code} ${d.message}`;
    return row.length > MAX_DIAG_CHARS ? `${row.slice(0, MAX_DIAG_CHARS - 1)}…` : row;
  });
  const more = diags.length > MAX_DIAGS ? `\n(+${diags.length - MAX_DIAGS} more)` : '';
  return `\n${rows.join('\n')}${more}`;
}

async function diagnose(
  root: string,
  abs: string,
  before: string,
  after: string,
  ms: number,
  env: Record<string, string>,
): Promise<Diag[]> {
  if (TS_EXTENSIONS.test(abs)) {
    const pair = await checkTs(root, abs, before, after, ms);
    return pair ? newDiags(pair.before, pair.after) : [];
  }
  if (extname(abs) !== '.py') return [];
  const a = await pythonSyntax(root, after, ms, env);
  if (!a.length) return [];
  return newDiags(await pythonSyntax(root, before, ms, env), a);
}

/**
 * After a successful write: format the file with the project's formatter (if configured and
 * fast) and check it. Returns text to append to the edit result: "" when there is nothing to say.
 * Never throws; a missing formatter or checker just means no note.
 */
export async function afterEdit(
  ctx: ToolContext,
  abs: string,
  before: string,
  opts: PostEditOptions = {},
): Promise<string> {
  if (!onHost(ctx)) return '';
  const root = ctx.jail.root;
  const notes: string[] = [];
  try {
    const written = await readFile(abs, 'utf8');
    const fmt = formatterFor(root, abs);
    let after = written;
    if (fmt) {
      const r = await run(fmt[0], fmt[1], root, opts.formatTimeoutMs ?? FORMAT_TIMEOUT_MS, ctx.env);
      after = await readFile(abs, 'utf8');
      if (r.ok && after !== written) notes.push(` Formatted with ${fmt[0].split('/').pop()}.`);
    }
    const diags = await diagnose(
      root,
      abs,
      before,
      after,
      opts.diagTimeoutMs ?? DIAG_TIMEOUT_MS,
      ctx.env,
    );
    notes.push(renderDiags(diags));
  } catch {
    // The edit is already written; a failed format or check never fails it.
  }
  return notes.join('');
}
