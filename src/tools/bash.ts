import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseDuration } from '../config/duration.js';
import { runShell } from '../core/exec.js';
import { checkCommand } from '../security/command-policy.js';
import { testSummary } from './output-summary.js';
import { fail, ok, type Tool } from './types.js';

export const HEAD_LINES = 20;
export const TAIL_LINES = 40;
/** Error-looking lines kept from the omitted middle. */
const MAX_ERROR_LINES = 40;
/** A command result never puts more than this into the conversation (~3k tokens). */
export const MAX_OUTPUT_CHARS = 12_000;
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

const schema = z.strictObject({
  command: z.string().min(1).describe('Shell command, run in the repo root'),
  timeout: z
    .string()
    .optional()
    .describe('e.g. "2m" (a bare number is milliseconds); capped by the run config'),
});

export const bashTool: Tool<typeof schema> = {
  name: 'bash',
  description:
    'Run a shell command in the repo root and wait for it to finish (never poll). Output is trimmed; use read_log for the full log. git writes, network, sudo and paths outside the repo are refused.',
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
    const verdict = checkCommand(input.command, ctx.policy);
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
    let timeoutMs = ctx.maxCmdTimeoutMs;
    if (input.timeout) {
      try {
        // A bare number is milliseconds, as most tool APIs mean it.
        const ms = /^\d+$/.test(input.timeout.trim())
          ? Number(input.timeout)
          : parseDuration(input.timeout);
        timeoutMs = Math.min(ms, ctx.maxCmdTimeoutMs);
      } catch {
        return fail(`invalid timeout "${input.timeout}"`);
      }
    }
    const id = ctx.nextCommandId();
    const r = await (ctx.exec ?? runShell)(input.command, {
      cwd: ctx.jail.root,
      env: ctx.env,
      timeoutMs,
      logPath: join(ctx.store.logsDir, `${id}.log`),
      redact: (s) => ctx.redactor.text(s),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const status = r.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : `exit ${r.exitCode}`;
    const body = trimOutput(r.output, id);
    const text = `[${status}, ${Math.round(r.durationMs)}ms, log ${id}]\n${body}`;
    return r.exitCode === 0 && !r.timedOut ? ok(text) : fail(text);
  },
};

const readLogSchema = z.strictObject({
  id: z
    .string()
    .regex(/^(cmd|gate)-[A-Za-z0-9_.-]+$/)
    .describe('Log id from a bash result, e.g. "cmd-3-2"'),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});

export const readLogTool: Tool<typeof readLogSchema> = {
  name: 'read_log',
  description:
    'Page through the full output of an earlier command or gate run, 400 lines at a time.',
  schema: readLogSchema,
  readOnly: true,
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
