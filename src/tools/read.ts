import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
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
});

export const readTool: Tool<typeof schema> = {
  name: 'read',
  description: `Read a file with line numbers, at most ${MAX_READ_LINES} lines per call. Files over ${MAX_READ_LINES} lines must be read by range; reading one without a range returns its outline.`,
  schema,
  readOnly: true,
  async run(input, ctx) {
    let text: string;
    try {
      text = await readFile(await resolvePath(ctx, input.path, 'read'), 'utf8');
    } catch (err) {
      return fail(
        err instanceof OmnexxError
          ? err.message
          : `cannot read ${input.path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
      );
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
      const row = `${String(n).padStart(5)}  ${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line is ${l.length} chars; search for text in it]` : l}`;
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
    if (ctx.reads) {
      const key = `${input.path}:${start}-${end}`;
      const hash = createHash('sha256').update(out).digest('hex');
      if (ctx.reads.get(key) === hash) {
        return ok(
          `${input.path}:${start}-${end} is unchanged since you read it earlier this cycle; that result is still in your context above.`,
        );
      }
      ctx.reads.set(key, hash);
    }
    return ok(out);
  },
};
