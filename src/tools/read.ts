import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
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

const start = z.number().int().positive().optional().describe('First line (1-based, inclusive)');
const end = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(`Last line (inclusive); at most ${MAX_READ_LINES} lines per file`);

const schema = z.strictObject({
  path: z.string().optional().describe('File path relative to the repo root'),
  start,
  end,
  files: z
    .array(
      z.strictObject({
        path: z.string().describe('File path relative to the repo root'),
        start,
        end,
      }),
    )
    .min(1)
    .max(MAX_READ_FILES)
    .optional()
    .describe(
      `Several files or ranges in one call, instead of path (up to ${MAX_READ_FILES}): one round trip instead of many`,
    ),
  anchors: z
    .boolean()
    .optional()
    .describe('Tag each line with a 2-char content hash, for replace_lines expected_hash'),
});

interface ReadTarget {
  path: string;
  start?: number | undefined;
  end?: number | undefined;
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
  const repeat = ctx.reads && alreadyShown(ctx.reads, t.path, text, first, last, anchors);
  return ok(repeat ?? `${body}${more}`);
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
    const out = await readOne(t, anchors, ctx, left);
    if (out.isError) failed++;
    sections.push(`${heading(t)}\n${out.content}`);
    left -= out.content.length;
  }
  const content = sections.join('\n\n');
  return failed === targets.length ? fail(content) : ok(content);
}

export const readTool: Tool<typeof schema> = {
  name: 'read',
  description: `Read a file with line numbers, at most ${MAX_READ_LINES} lines per file. Files over ${MAX_READ_LINES} lines must be read by range; reading one without a range returns its outline. To read several files or ranges, pass them all in files: [...] in one call.`,
  schema,
  readOnly: true,
  concurrent: true,
  async run(input, ctx) {
    if (input.files && input.path !== undefined)
      return fail('read takes either path (with start/end) or files: [...], not both');
    if (input.files) return readMany(input.files, input.anchors, ctx);
    if (input.path === undefined) return fail('read needs path, or files: [{path, start, end}]');
    return readOne(
      { path: input.path, start: input.start, end: input.end },
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

const covers = (ranges: readonly [number, number][], start: number, end: number): boolean => {
  for (let n = start; n <= end; n++) if (!ranges.some(([a, b]) => n >= a && n <= b)) return false;
  return true;
};

/**
 * A short note instead of the lines when the file is unchanged and every requested line was
 * already shown this cycle (any earlier range, not just the same one). Asking for exactly the
 * same range again right after returns the lines, in case the earlier result was trimmed.
 */
function alreadyShown(
  reads: Map<string, string>,
  path: string,
  text: string,
  start: number,
  end: number,
  anchors: boolean | undefined,
): string | undefined {
  const covKey = `cov:${path}${anchors ? ':a' : ''}`;
  const lastKey = `last:${path}${anchors ? ':a' : ''}`;
  const hash = createHash('sha256').update(text).digest('hex');
  const seen = parseCoverage(reads.get(covKey));
  const range = `${String(start)}-${String(end)}`;
  if (seen.hash === hash && covers(seen.ranges, start, end) && reads.get(lastKey) !== range) {
    reads.set(lastKey, range);
    return `${path} is unchanged and lines ${range} were already shown earlier this cycle; use that result above. (Ask for the same range again if it is no longer in your context.)`;
  }
  const ranges =
    seen.hash === hash
      ? [...seen.ranges, [start, end] as [number, number]]
      : [[start, end] as [number, number]];
  reads.set(covKey, `${hash}|${ranges.map(([a, b]) => `${String(a)}-${String(b)}`).join(',')}`);
  reads.delete(lastKey);
  return undefined;
}
