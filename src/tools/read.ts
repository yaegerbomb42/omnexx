import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { lineTag } from './anchors.js';
import { openError } from './did-you-mean.js';
import { extractSymbols, renderOutline } from './outline.js';
import { fail, ok, resolvePath, type Tool } from './types.js';

export const MAX_READ_LINES = 400;
/** Longer lines (minified or generated code) are clipped; search finds text inside them. */
export const MAX_LINE_CHARS = 2_000;
/** One read returns at most this much (~20k tokens); a range past it ends early. */
export const MAX_READ_CHARS = 60_000;

const schema = z.strictObject({
  path: z.string().describe('File path relative to the repo root'),
  start: z.number().int().positive().optional().describe('First line (1-based, inclusive)'),
  end: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Last line (inclusive); at most 400 lines per call'),
  anchors: z
    .boolean()
    .optional()
    .describe('Tag each line with a 2-char content hash, for replace_lines expected_hash'),
});

function clipLine(l: string): string {
  if (l.length <= MAX_LINE_CHARS) return l;
  return `${l.slice(0, MAX_LINE_CHARS)}… [line is ${l.length} chars; search for text in it]`;
}

export const readTool: Tool<typeof schema> = {
  name: 'read',
  description: `Read a file with line numbers, at most ${MAX_READ_LINES} lines per call. Files over ${MAX_READ_LINES} lines must be read by range; reading one without a range returns its outline.`,
  schema,
  readOnly: true,
  concurrent: true,
  async run(input, ctx) {
    let text: string;
    try {
      text = await readFile(await resolvePath(ctx, input.path, 'read'), 'utf8');
    } catch (err) {
      return fail(await openError(ctx, input.path, err, '', 'read'));
    }
    if (text.includes('\0')) return fail(`${input.path} looks binary; not shown`);
    const lines = text.split('\n');
    if (input.start === undefined && input.end === undefined && lines.length > MAX_READ_LINES) {
      return ok(
        `${input.path} has ${lines.length} lines; read it by range (start/end). Outline:\n${renderOutline(extractSymbols(text), lines.length)}`,
      );
    }
    const start = input.start ?? 1;
    let end = Math.min(input.end ?? lines.length, start + MAX_READ_LINES - 1, lines.length);
    if (start > lines.length) return fail(`${input.path} has only ${lines.length} lines`);
    const shown: string[] = [];
    let size = 0;
    for (let n = start; n <= end; n++) {
      const l = lines[n - 1] ?? '';
      const tag = input.anchors ? ` ${lineTag(l)}` : ' ';
      const row = `${String(n).padStart(5)}${tag} ${clipLine(l)}`;
      if (shown.length && size + row.length > MAX_READ_CHARS) {
        end = n - 1;
        break;
      }
      shown.push(row);
      size += row.length + 1;
    }
    const body = shown.join('\n');
    const more = end < lines.length ? `\n(lines ${end + 1}-${lines.length} not shown)` : '';
    const out = `${body}${more}`;
    const repeat =
      ctx.reads && alreadyShown(ctx.reads, input.path, text, start, end, input.anchors);
    if (repeat) return ok(repeat);
    return ok(out);
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
