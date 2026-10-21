import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { runShell } from '../core/exec.js';
import { checkTs, TS_EXTENSIONS, type Diag } from './ts-check.js';
import type { ToolContext } from './types.js';

interface TsParseDiag {
  start: number;
  code: number;
  messageText: string | { messageText: string };
}

interface TsCompiler {
  createSourceFile: (
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number,
  ) => {
    parseDiagnostics: readonly TsParseDiag[];
    getLineAndCharacterOfPosition: (pos: number) => { line: number; character: number };
  };
  ScriptTarget: { Latest: number };
  ScriptKind?: {
    JS: number;
    JSX: number;
    TS: number;
    TSX: number;
  };
  flattenDiagnosticMessageText: (diag: string | { messageText: string }, sep: string) => string;
}

const tsCacheByRoot = new Map<string, TsCompiler | null>();
let fallbackTs: TsCompiler | null | undefined;

function getTs(root: string): TsCompiler | null {
  const cached = tsCacheByRoot.get(root);
  if (cached !== undefined) return cached;
  try {
    const req = createRequire(join(root, 'package.json'));
    const ts = req('typescript') as TsCompiler;
    tsCacheByRoot.set(root, ts);
    return ts;
  } catch {
    if (fallbackTs === undefined) {
      try {
        fallbackTs = createRequire(import.meta.url)('typescript') as TsCompiler;
      } catch {
        fallbackTs = null;
      }
    }
    tsCacheByRoot.set(root, fallbackTs);
    return fallbackTs;
  }
}

function scriptKindFor(ts: TsCompiler, abs: string): number | undefined {
  if (!ts.ScriptKind) return undefined;
  const ext = extname(abs).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Render a 20-line anchored snippet centered around `focusLine` (1-based).
 * When `errorMarker` is provided, annotates the offending line with `>` and an inline column pointer.
 */
export function renderAnchoredSnippet(
  text: string,
  focusLine: number,
  windowLines = 20,
  errorMarker?: { column?: number; message?: string },
): string {
  const lines = text.split('\n');
  const total = lines.length;
  const clampedFocus = Math.max(1, Math.min(focusLine, total));
  const half = Math.floor(windowLines / 2);
  let start = Math.max(1, clampedFocus - half);
  const end = Math.min(total, start + windowLines - 1);
  if (end - start + 1 < windowLines) {
    start = Math.max(1, end - windowLines + 1);
  }

  const out: string[] = [];
  for (let ln = start; ln <= end; ln++) {
    const raw = lines[ln - 1] ?? '';
    const isFocus = errorMarker !== undefined && ln === clampedFocus;
    const prefix = isFocus ? '>' : ' ';
    out.push(`${prefix}${String(ln).padStart(5)} | ${raw}`);
    if (isFocus && errorMarker.message) {
      const col = Math.max(1, errorMarker.column ?? 1);
      const caretPad = ' '.repeat(Math.min(col - 1, 100));
      out.push(`       | ${caretPad}^── ${errorMarker.message}`);
    }
  }
  return out.join('\n');
}

/**
 * Persistent background Python AST worker so `.py` syntax gates execute in ~0.8ms
 * via stdio JSON-RPC instead of paying 50ms+ process startup per edit.
 */
const PY_DAEMON_SCRIPT = String.raw`import ast, json, sys
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        req = json.loads(raw)
        compile(req.get("src", ""), req.get("path", "<memory>"), "exec", ast.PyCF_ONLY_AST)
        sys.stdout.write('{"ok":true}\n')
    except SyntaxError as e:
        sys.stdout.write(json.dumps({
            "ok": False,
            "line": e.lineno or 1,
            "col": e.offset or 1,
            "msg": e.msg or "invalid syntax"
        }) + "\n")
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": True}) + "\n")
    sys.stdout.flush()
`;

class PythonAstDaemon {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pending:
    ((res: { ok: boolean; line?: number; col?: number; msg?: string }) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  check(
    abs: string,
    text: string,
    timeoutMs = 250,
  ): Promise<{ ok: boolean; line?: number; col?: number; msg?: string }> {
    const next = this.queue.then(
      () => this.runOnce(abs, text, timeoutMs),
      () => this.runOnce(abs, text, timeoutMs),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private ensureWorker(): ChildProcess | null {
    if (this.proc?.exitCode === null && !this.proc.killed) {
      return this.proc;
    }
    try {
      const p = spawn('python3', ['-u', '-c', PY_DAEMON_SCRIPT], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      p.unref();
      p.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        const nl = this.buffer.indexOf('\n');
        if (nl >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          const cb = this.pending;
          this.pending = null;
          if (cb) {
            try {
              cb(JSON.parse(line) as { ok: boolean; line?: number; col?: number; msg?: string });
            } catch {
              cb({ ok: true });
            }
          }
        }
      });
      const reset = () => {
        if (this.proc === p) this.proc = null;
        const cb = this.pending;
        this.pending = null;
        if (cb) cb({ ok: true });
      };
      p.once('exit', reset);
      p.once('error', reset);
      this.proc = p;
      return p;
    } catch {
      return null;
    }
  }

  private runOnce(
    abs: string,
    text: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; line?: number; col?: number; msg?: string }> {
    const worker = this.ensureWorker();
    const workerStdin = worker?.stdin;
    if (!worker || !workerStdin) return Promise.resolve({ ok: true });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null;
        try {
          worker.kill('SIGKILL');
        } catch {
          // ignore
        }
        this.proc = null;
        resolve({ ok: true });
      }, timeoutMs);

      this.pending = (res) => {
        clearTimeout(timer);
        resolve(res);
      };

      workerStdin.write(`${JSON.stringify({ path: abs, src: text })}\n`);
    });
  }
}

const pyDaemon = new PythonAstDaemon();

/**
 * Pre-write syntax gate (<5ms): checks AST/parse validity in memory before disk mutation.
 * Returns a 20-line anchored echo snippet on failure so the agent can self-correct without `read_file`.
 */
export async function preWriteSyntaxCheck(
  ctx: ToolContext,
  abs: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!onHost(ctx)) return { ok: true };
  const root = ctx.jail.root;
  const ext = extname(abs).toLowerCase();

  // 1. TypeScript / JavaScript in-memory parser (~0.4-1.8ms with setParentNodes = false)
  if (TS_EXTENSIONS.test(abs)) {
    const ts = getTs(root);
    if (!ts) return { ok: true };
    try {
      const sf = ts.createSourceFile(
        abs,
        text,
        ts.ScriptTarget.Latest,
        false,
        scriptKindFor(ts, abs),
      );
      const err = sf.parseDiagnostics[0];
      if (err) {
        const { line, character } = sf.getLineAndCharacterOfPosition(err.start);
        const line1 = line + 1;
        const col1 = character + 1;
        const msg = ts.flattenDiagnosticMessageText(err.messageText, ' ');
        const snippet = renderAnchoredSnippet(text, line1, 20, {
          column: col1,
          message: `TS${String(err.code)} ${msg}`,
        });
        return {
          ok: false,
          error: `Syntax error in proposed edit at line ${String(line1)}, col ${String(col1)}: TS${String(err.code)} ${msg}. Mutation discarded without writing to disk.\n\n${snippet}`,
        };
      }
    } catch {
      return { ok: true };
    }
    return { ok: true };
  }

  // 2. Python in-memory AST daemon (~0.5-1.4ms over persistent stdio pipe)
  if (ext === '.py' || ext === '.pyi') {
    const res = await pyDaemon.check(abs, text, 300);
    if (!res.ok) {
      const line1 = res.line ?? 1;
      const col1 = res.col ?? 1;
      const msg = res.msg ?? 'invalid syntax';
      const snippet = renderAnchoredSnippet(text, line1, 20, {
        column: col1,
        message: `SyntaxError: ${msg}`,
      });
      return {
        ok: false,
        error: `Syntax error in proposed edit at line ${String(line1)}: ⚠ line ${String(line1)}: SyntaxError ${msg}. Mutation discarded without writing to disk.\n\n${snippet}`,
      };
    }
    return { ok: true };
  }

  // 3. JSON in-memory syntax gate (<0.2ms)
  if (ext === '.json') {
    try {
      JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const posMatch = /position\s+(\d+)/i.exec(msg);
      let line1 = 1;
      let col1 = 1;
      if (posMatch?.[1]) {
        const offset = Number(posMatch[1]);
        const head = text.slice(0, offset);
        const parts = head.split('\n');
        line1 = parts.length;
        col1 = (parts[parts.length - 1]?.length ?? 0) + 1;
      }
      const snippet = renderAnchoredSnippet(text, line1, 20, {
        column: col1,
        message: `JSONError: ${msg}`,
      });
      return {
        ok: false,
        error: `Syntax error in proposed edit at line ${String(line1)}: ${msg}. Mutation discarded without writing to disk.\n\n${snippet}`,
      };
    }
  }

  return { ok: true };
}

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
export function onHost(ctx: ToolContext): boolean {
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
    return false;
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

async function pythonSyntax(abs: string, text: string, ms: number): Promise<Diag[]> {
  const res = await pyDaemon.check(abs, text, ms);
  if (res.ok) return [];
  return [{ line: res.line ?? 1, code: 'SyntaxError', message: res.msg ?? 'invalid syntax' }];
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
): Promise<Diag[]> {
  if (TS_EXTENSIONS.test(abs)) {
    const pair = await checkTs(root, abs, before, after, ms);
    return pair ? newDiags(pair.before, pair.after) : [];
  }
  if (extname(abs) !== '.py') return [];
  const a = await pythonSyntax(abs, after, ms);
  if (!a.length) return [];
  return newDiags(await pythonSyntax(abs, before, ms), a);
}

/** In-memory diagnostic comparison for candidate tournament scoring before disk writes. */
export async function diagnoseInMemory(
  ctx: ToolContext,
  abs: string,
  before: string,
  after: string,
  timeoutMs = DIAG_TIMEOUT_MS,
): Promise<Diag[]> {
  if (!onHost(ctx)) return [];
  return diagnose(ctx.jail.root, abs, before, after, timeoutMs);
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
    const diags = await diagnose(root, abs, before, after, opts.diagTimeoutMs ?? DIAG_TIMEOUT_MS);
    notes.push(renderDiags(diags));
  } catch {
    // The edit is already written; a failed format or check never fails it.
  }
  return notes.join('');
}
