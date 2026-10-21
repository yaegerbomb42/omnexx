import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { parseDuration } from '../config/duration.js';
import { runShell, type SessionName } from '../core/exec.js';
import { checkCommand } from '../security/command-policy.js';
import { compressOutput } from './output-compress.js';
import { testSummary } from './output-summary.js';
import { testDigest } from './test-digest.js';
import { fail, ok, type Tool } from './types.js';

export const HEAD_LINES = 12;
export const TAIL_LINES = 20;
/** Error-looking lines kept from the omitted middle. */
const MAX_ERROR_LINES = 20;
/** A command result never puts more than this into the conversation (~1.5k tokens). */
export const MAX_OUTPUT_CHARS = 6_000;
const ERROR_LINE =
  /\b(error|fail(ed|ure|ing)?|exception|panic|traceback|assert(ion)?|cannot|not found|undefined)\b/i;

/** Longer lines (minified bundles, base64, one-line JSON) are clipped; read_log has them whole. */
export const MAX_LINE_CHARS = 500;

const clipLine = (l: string): string =>
  l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [${l.length} chars]` : l;

/**
 * Lean by default (plan §4.4): the test outcome first when the output is a test run, then the
 * first 20 and last 40 lines plus error-looking lines from the middle, within MAX_OUTPUT_CHARS.
 * Deterministic, costs no tokens; the full output stays readable through read_log.
 */
export function trimOutput(output: string, logId: string): string {
  const lines = output.replace(/\s+$/, '').split('\n').map(clipLine);
  const summary = testSummary(output);
  const lead = summary ? [`tests: ${summary}`] : [];
  if (lines.length <= HEAD_LINES + TAIL_LINES && output.length <= MAX_OUTPUT_CHARS)
    return [...(summary && lines.length > 10 ? lead : []), ...lines].join('\n');
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const middle = lines.slice(HEAD_LINES, -TAIL_LINES);
  const errors = middle.filter((l) => ERROR_LINE.test(l)).slice(0, MAX_ERROR_LINES);
  const omitted = middle.length - errors.length;
  const note = `… ${String(omitted)} lines omitted (read_log id="${logId}" to page through them)${errors.length ? '; error-looking lines kept:' : ''}`;
  const parts = [...lead, ...head, note, ...errors, '…', ...tail];
  return capChars(parts, logId);
}

/** Drop lines from the head side of the tail until the result fits, keeping lead and errors. */
function capChars(parts: string[], logId: string): string {
  let text = parts.join('\n');
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const tailStart = parts.lastIndexOf('…') + 1;
  const kept = [...parts];
  while (kept.join('\n').length > MAX_OUTPUT_CHARS && kept.length > tailStart + 1)
    kept.splice(tailStart, 1);
  text = kept.join('\n');
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [cut at ${String(MAX_OUTPUT_CHARS)} chars; read_log id="${logId}"]`;
}

/** `cmd <<'EOF'` … `EOF` (also <<-, unquoted or "quoted" tags), the whole command. */
const HEREDOC =
  /^([^\n]*?)\s*<<(-?)\s*(['"]?)([A-Za-z_]\w*)\3[ \t]*\n([\s\S]*?)\n?[ \t]*\4[ \t]*\n?$/;

/**
 * Models write `python3 - <<'EOF' … EOF`; the policy refuses `<<` (its body would parse as shell
 * words). The body becomes the command's stdin and only the command line is checked.
 */
export function splitHeredoc(command: string): { command: string; stdin: string } | undefined {
  const m = HEREDOC.exec(command);
  if (!m?.[1]) return undefined;
  const body = m[5] ?? '';
  const stdin = m[2] === '-' ? body.replace(/^\t+/gm, '') : body;
  return { command: m[1].trim(), stdin: stdin ? `${stdin}\n` : '' };
}

const SESSION_NAMES = ['main', 'test', 'repl'] as const;

const schema = z.strictObject({
  command: z.string().min(1).describe('Shell command, run in a persistent named session'),
  timeout: z.string().optional().describe('Default 2m, max 10m; a bare number is ms'),
  session: z
    .enum(SESSION_NAMES)
    .optional()
    .describe('Named persistent shell session ("main" default, "test", or "repl")'),
  reset_session: z
    .boolean()
    .optional()
    .describe('Reset the persistent session back to a clean repo root shell before running'),
});

const DEV_SERVER_PEEK_MS = 20_000;
/**
 * A command without its own timeout gets this much, not the run's whole command cap (30 min):
 * a stray `find /` once held a cycle for 7 minutes. Longer builds and suites pass `timeout`.
 */
export const DEFAULT_BASH_TIMEOUT_MS = 2 * 60_000;
/**
 * The most a command may ask for. The run's command cap (30 min) is for gates; an agent's own
 * command that needs longer is hung (bench hard10 task-04 sat 26 minutes on a script it gave "30m").
 */
export const MAX_BASH_TIMEOUT_MS = 10 * 60_000;
const DEV_SERVERS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun) (?:run )?(?:dev|start|serve|preview|watch)\b/,
  /\bvite(?: dev| serve| preview)?(?:$|[\s&;])/,
  /\bnext (?:dev|start)\b/,
  /\b(?:nodemon|http-server|live-server)\b/,
  /\b(?:webpack serve|astro dev|remix dev)\b/,
];

/** A command that starts a long-running dev server (not a build or a test run). */
export function isDevServer(command: string): boolean {
  if (/\b(build|test|lint|typecheck)\b/.test(command) && !/(&&|;)/.test(command)) return false;
  const flat = command.replace(/\s+/g, ' ');
  return DEV_SERVERS.some((re) => re.test(flat));
}

/** Auto-route obvious test suites to the `test` session when `session` is not explicitly passed. */
function inferSession(command: string, explicit?: SessionName): SessionName {
  if (explicit) return explicit;
  if (/^\s*(?:pytest|vitest|jest|cargo test|go test|npm test|pnpm test|yarn test|bun test)\b/.test(command)) {
    return 'test';
  }
  return 'main';
}

/** "Missing script" from npm: name the scripts that do exist, in the folder the command ran in. */
export async function missingScriptHint(
  output: string,
  command: string,
  root: string,
  activeCwd?: string,
): Promise<string> {
  if (!/Missing script:/i.test(output)) return '';
  const dir =
    /(?:^|&&|;)\s*cd\s+([^\s&;|]+)/.exec(command)?.[1] ??
    (activeCwd ? relative(root, activeCwd) || '.' : '.');
  // Only folders inside the repo.
  if (dir.startsWith('/') || dir.startsWith('~') || dir.split('/').includes('..')) return '';
  try {
    const pkg = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const names = Object.keys(pkg.scripts ?? {});
    return names.length
      ? `\n[scripts in ${dir}/package.json: ${names.join(', ')}]`
      : `\n[${dir}/package.json has no scripts]`;
  } catch {
    return '';
  }
}

/** A missing binary or path: point at the package scripts, which are how this repo is run. */
export async function shellHint(output: string, root: string): Promise<string> {
  if (!/command not found|No such file or directory/i.test(output)) return '';
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const tips = [
      scripts.test ? 'tests run with `npm test`' : '',
      scripts.lint ? 'lint runs with `npm run lint`' : '',
      scripts.build ? 'the build is `npm run build`' : '',
    ].filter(Boolean);
    return tips.length ? `\n[${tips.join('; ')}]` : '';
  } catch {
    return '';
  }
}

function commandStatus(
  r: { timedOut: boolean; exitCode: number; cwd?: string },
  timeoutMs: number,
  peeked: boolean,
  sessionName: string,
  repoRoot: string,
): string {
  const secs = Math.round(timeoutMs / 1000);
  const relCwd = r.cwd && r.cwd !== repoRoot ? ` cwd=${relative(repoRoot, r.cwd) || '.'}` : '';
  const sessTag = `session=${sessionName}${relCwd}`;
  if (peeked)
    return `dev server still running after ${secs}s; stopped by the harness (it started), ${sessTag}`;
  if (r.timedOut)
    return `timed out after ${secs}s (${sessTag}); if it needs longer, run it again with a larger timeout (e.g. "10m")`;
  return `exit ${String(r.exitCode)}, ${sessTag}`;
}

export const bashTool: Tool<typeof schema> = {
  name: 'bash',
  description:
    "Run a shell command in a persistent named session ('main', 'test', 'repl') that preserves cwd, virtualenvs, and exported variables across turns. Dev servers run 20 s, then stop; don't background them. git writes, network, sudo and outside paths need the person's OK; unattended runs refuse them.",
  schema,
  readOnly: false,
  // Models often send the timeout as a number of milliseconds.
  normalize: (input) =>
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { timeout?: unknown }).timeout === 'number'
      ? { ...input, timeout: String((input as { timeout: number }).timeout) }
      : input,
  async run(input, ctx) {
    const heredoc = splitHeredoc(input.command);
    const command = heredoc?.command ?? input.command;
    const verdict = checkCommand(command, ctx.policy);
    const allowed =
      verdict.allowed ||
      (ctx.ask !== undefined &&
        (await ctx.ask(`run \`${input.command}\`? Normally refused: ${verdict.reason}`)));
    if (!verdict.allowed && !allowed) {
      ctx.events.emit('tool.denied', {
        tool: 'bash',
        rule: verdict.rule,
        reason: verdict.reason,
        command: input.command,
      });
      return fail(`refused by policy (${verdict.rule}): ${verdict.reason}`);
    }
    ctx.onBash?.(input.command);
    let timeoutMs = Math.min(DEFAULT_BASH_TIMEOUT_MS, ctx.maxCmdTimeoutMs);
    if (input.timeout) {
      try {
        // A bare number is milliseconds, as most tool APIs mean it.
        const ms = /^\d+$/.test(input.timeout.trim())
          ? Number(input.timeout)
          : parseDuration(input.timeout);
        timeoutMs = Math.min(ms, MAX_BASH_TIMEOUT_MS, ctx.maxCmdTimeoutMs);
      } catch {
        return fail(`invalid timeout "${input.timeout}"`);
      }
    }
    // A dev server never exits: peek at its startup instead of waiting out the whole timeout.
    const devServer = isDevServer(input.command);
    if (devServer) timeoutMs = Math.min(timeoutMs, DEV_SERVER_PEEK_MS);
    const id = ctx.nextCommandId();
    const sessionName = inferSession(command, input.session);

    const r = await (ctx.exec ?? runShell)(command, {
      ...(heredoc ? { stdin: heredoc.stdin } : {}),
      cwd: ctx.jail.root,
      env: ctx.env,
      timeoutMs,
      logPath: join(ctx.store.logsDir, `${id}.log`),
      redact: (s) => ctx.redactor.text(s),
      session: sessionName,
      ...(input.reset_session ? { resetSession: true } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const peeked = devServer && r.timedOut;
    const status = commandStatus(r, timeoutMs, peeked, sessionName, ctx.jail.root);
    // A recognized test failure becomes a short digest; anything else stays on trimOutput.
    const body =
      (testDigest(command, r.output, id) ?? trimOutput(compressOutput(r.output), id)) +
      (await missingScriptHint(r.output, input.command, ctx.jail.root, r.cwd)) +
      (await shellHint(r.output, ctx.jail.root));
    const text = `[${status}, ${Math.round(r.durationMs)}ms, log ${id}]\n${body}`;
    return peeked || (r.exitCode === 0 && !r.timedOut) ? ok(text) : fail(text);
  },
};

const readLogSchema = z.strictObject({
  id: z
    .string()
    .regex(/^(cmd|gate)-[A-Za-z0-9_.-]+$/)
    .describe('Log id from a bash result'),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});

export const readLogTool: Tool<typeof readLogSchema> = {
  name: 'read_log',
  description:
    'Page through the full output of an earlier command or gate run, 400 lines at a time.',
  schema: readLogSchema,
  readOnly: true,
  concurrent: true,
  async run(input, ctx) {
    let text: string;
    try {
      text = await readFile(join(ctx.store.logsDir, `${input.id}.log`), 'utf8');
    } catch {
      return fail(`no log ${input.id}`);
    }
    const lines = text.split('\n');
    const start = input.start ?? 1;
    const end = Math.min(input.end ?? start + 399, start + 399, lines.length);
    return ok(
      `${lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(6)}  ${l}`)
        .join('\n')}${end < lines.length ? `\n(${lines.length - end} more lines)` : ''}`,
    );
  },
};
