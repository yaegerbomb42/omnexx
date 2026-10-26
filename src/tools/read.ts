import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { estimateTokens } from '../core/tokens.js';
import { lineTag } from './anchors.js';
import { openError } from './did-you-mean.js';
import { extractSymbols, renderOutline } from './outline.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from './types.js';

export const MAX_READ_LINES = 400;
/** Longer lines (minified or generated code) are clipped; search finds text inside them. */
export const MAX_LINE_CHARS = 2_000;
/** One read returns at most this much (~20k tokens); a range past it ends early. */
export const MAX_READ_CHARS = 60_000;

/** Files one read may take through `files`. */
export const MAX_READ_FILES = 10;
/** Below this much of a multi-file read's budget, a file isn't started: a few lines only cost a re-read. */
const MIN_SECTION_CHARS = 2_000;

const start = z.number().int().positive().optional();
const end = z.number().int().positive().optional();

const schema = z.strictObject({
  path: z.string().optional().describe('Path relative to the repo root'),
  start,
  end,
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        start,
        end,
      }),
    )
    .min(1)
    .max(MAX_READ_FILES)
    .optional()
    .describe(`Several files or ranges in one call (up to ${MAX_READ_FILES})`),
  anchors: z.boolean().optional().describe('Tag lines with a content hash, for replace_lines'),
  note: z.string().optional().describe('Why you need it; reused if a later read is skipped'),
});

interface ReadTarget {
  path: string;
  start?: number | undefined;
  end?: number | undefined;
  note?: string | undefined;
}

function clipLine(l: string): string {
  if (l.length <= MAX_LINE_CHARS) return l;
  return `${l.slice(0, MAX_LINE_CHARS)}… [line is ${l.length} chars; search for text in it]`;
}

/** One file (or range of it), shown in at most `maxChars`. */
async function readOne(
  t: ReadTarget,
  anchors: boolean | undefined,
  ctx: ToolContext,
  maxChars: number,
): Promise<ToolOutput> {
  let text: string;
  try {
    text = await readFile(await resolvePath(ctx, t.path, 'read'), 'utf8');
  } catch (err) {
    return fail(await openError(ctx, t.path, err, '', 'read'));
  }
  if (text.includes('\0')) return fail(`${t.path} looks binary; not shown`);
  const lines = text.split('\n');
  if (t.start === undefined && t.end === undefined && lines.length > MAX_READ_LINES) {
    return ok(
      `${t.path} has ${lines.length} lines; read it by range (start/end). Outline:\n${renderOutline(extractSymbols(text), lines.length)}`,
    );
  }
  const first = t.start ?? 1;
  if (t.end !== undefined && t.end < first) {
    return fail(`${t.path}: start line (${first}) cannot be greater than end line (${t.end})`);
  }
  let last = Math.min(t.end ?? lines.length, first + MAX_READ_LINES - 1, lines.length);
  if (first > lines.length) return fail(`${t.path} has only ${lines.length} lines`);
  const shown: string[] = [];
  let size = 0;
  for (let n = first; n <= last; n++) {
    const l = lines[n - 1] ?? '';
    const tag = anchors ? ` ${lineTag(l)}` : ' ';
    const row = `${String(n).padStart(5)}${tag} ${clipLine(l)}`;
    if (shown.length && size + row.length > maxChars) {
      last = n - 1;
      break;
    }
    shown.push(row);
    size += row.length + 1;
  }
  const body = shown.join('\n');
  const more = last < lines.length ? `\n(lines ${last + 1}-${lines.length} not shown)` : '';
  const full = `${body}${more}`;
  const repeat =
    ctx.reads &&
    alreadyShown(ctx.reads, t.path, text, first, last, anchors, {
      ctx,
      body: full,
      ...(t.note ? { note: t.note } : {}),
    });
  return ok(repeat ?? full);
}

/** Header of one file's section in a multi-file read. */
function heading(t: ReadTarget): string {
  const range =
    t.start !== undefined || t.end !== undefined
      ? ` (lines ${String(t.start ?? 1)}-${t.end === undefined ? 'end' : String(t.end)})`
      : '';
  return `== ${t.path}${range} ==`;
}

/**
 * Several files in one call, each under its own heading, sharing one MAX_READ_CHARS budget.
 * A file that can't be read is reported in its section; the call fails only if none could be.
 */
async function readMany(
  targets: readonly ReadTarget[],
  anchors: boolean | undefined,
  ctx: ToolContext,
  note?: string,
): Promise<ToolOutput> {
  // In order, each with what's left of the budget: one read per file, so the already-shown
  // bookkeeping sees each range once.
  const sections: string[] = [];
  let left = MAX_READ_CHARS;
  let failed = 0;
  for (const t of targets) {
    if (left < MIN_SECTION_CHARS) {
      sections.push(`${heading(t)}\n(not read: this call reached its size limit; read it next)`);
      continue;
    }
    const out = await readOne(
      note !== undefined && t.note === undefined ? { ...t, note } : t,
      anchors,
      ctx,
      left,
    );
    if (out.isError) failed++;
    sections.push(`${heading(t)}\n${out.content}`);
    left -= out.content.length;
  }
  const content = sections.join('\n\n');
  return failed === targets.length ? fail(content) : ok(content);
}

export const readTool: Tool<typeof schema> = {
  name: 'read',
  description: `Read files with line numbers, at most ${MAX_READ_LINES} lines each; a longer file needs a range (without one you get its outline).`,
  schema,
  readOnly: true,
  concurrent: true,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const rest = { ...raw };
    delete rest.paths;
    delete rest.start_line;
    delete rest.end_line;
    const files = raw.files ?? raw.paths;
    return {
      ...rest,
      start: raw.start ?? raw.start_line,
      end: raw.end ?? raw.end_line,
      ...(files !== undefined ? { files } : {}),
    };
  },
  async run(input, ctx) {
    if (input.files && input.path !== undefined)
      return fail('read takes either path (with start/end) or files: [...], not both');
    if (input.files) return readMany(input.files, input.anchors, ctx, input.note);
    if (input.path === undefined) return fail('read needs path, or files: [{path, start, end}]');
    return readOne(
      {
        path: input.path,
        start: input.start,
        end: input.end,
        ...(input.note ? { note: input.note } : {}),
      },
      input.anchors,
      ctx,
      MAX_READ_CHARS,
    );
  },
};

/** Line ranges of a file already shown this cycle, kept as `hash|a-b,c-d` in the reads cache. */
function parseCoverage(value: string | undefined): { hash: string; ranges: [number, number][] } {
  const [hash = '', list = ''] = (value ?? '').split('|');
  const ranges = list
    .split(',')
    .filter(Boolean)
    .map((r) => r.split('-').map(Number) as [number, number]);
  return { hash, ranges };
}

/** How a file was first shown this cycle: the step, and the agent's note about it. */
interface ReadMeta {
  step?: number;
  note?: string;
}

function parseMeta(value: string | undefined): ReadMeta {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const MAX_NOTE = 300;

/** Notes are model-written; keep a stale or runaway one from inflating the pointer. */
function shortNote(note: string | undefined): string | undefined {
  return note && note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE)}…` : note;
}

const covers = (ranges: readonly [number, number][], start: number, end: number): boolean => {
  for (let n = start; n <= end; n++) if (!ranges.some(([a, b]) => n >= a && n <= b)) return false;
  return true;
};

/**
 * A short note instead of the lines when the file is unchanged and every requested line was
 * already shown this cycle (any earlier range, not just the same one). Asking for exactly the
 * same range again right after returns the lines, in case the earlier result was trimmed.
 *
 * With a step in the context (the worker loop always sets one) the pointer says "unchanged since
 * step N" and repeats the note the agent attached to the first read. The tokens the pointer
 * avoided are recorded as waste saved, so `omnexx usage` can price the guard.
 */
function alreadyShown(
  reads: Map<string, string>,
  path: string,
  text: string,
  start: number,
  end: number,
  anchors: boolean | undefined,
  opts: { ctx: ToolContext; body: string; note?: string },
): string | undefined {
  const suffix = anchors ? ':a' : '';
  const covKey = `cov:${path}${suffix}`;
  const lastKey = `last:${path}${suffix}`;
  const metaKey = `meta:${path}${suffix}`;
  const hash = createHash('sha256').update(text).digest('hex');
  const seen = parseCoverage(reads.get(covKey));
  const range = `${String(start)}-${String(end)}`;
  if (seen.hash === hash && covers(seen.ranges, start, end) && reads.get(lastKey) !== range) {
    reads.set(lastKey, range);
    const meta = parseMeta(reads.get(metaKey));
    const step = meta.step;
    const note = shortNote(opts.note ?? meta.note);
    const pointer =
      step !== undefined
        ? `${path} is unchanged since step ${String(step)}; lines ${range} were already shown earlier this cycle.${note ? ` Earlier note: ${note}` : ''} (Ask for the same range again if it is no longer in your context.)`
        : `${path} is unchanged and lines ${range} were already shown earlier this cycle; use that result above.${note ? ` Earlier note: ${note}` : ''} (Ask for the same range again if it is no longer in your context.)`;
    opts.ctx.onWaste?.({
      kind: 'repeat_read',
      tokens: Math.max(0, estimateTokens(opts.body) - estimateTokens(pointer)),
      detail: `repeat read of ${path} (lines ${range}) answered with a pointer`,
      path,
      ...(step !== undefined ? { sinceStep: step } : {}),
    });
    return pointer;
  }
  const ranges =
    seen.hash === hash
      ? [...seen.ranges, [start, end] as [number, number]]
      : [[start, end] as [number, number]];
  reads.set(covKey, `${hash}|${ranges.map(([a, b]) => `${String(a)}-${String(b)}`).join(',')}`);
  reads.delete(lastKey);
  const prior = seen.hash === hash ? parseMeta(reads.get(metaKey)) : {};
  const note = shortNote(opts.note ?? prior.note ?? firstLine(opts.body));
  reads.set(
    metaKey,
    JSON.stringify({
      ...(prior.step !== undefined
        ? { step: prior.step }
        : opts.ctx.step !== undefined
          ? { step: opts.ctx.step }
          : {}),
      ...(note ? { note } : {}),
    }),
  );
  return undefined;
}

/** A short stand-in for the agent's note when it did not write one. */
function firstLine(body: string): string | undefined {
  const line = body
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\s+/, '').trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 160) : undefined;
}
