import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { extractSymbols, renderOutline } from './outline.js';
import { fail, ok, type Tool } from './types.js';

export const MAX_READ_LINES = 400;

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
      text = await readFile(ctx.jail.resolve(input.path, 'read'), 'utf8');
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
    const end = Math.min(input.end ?? lines.length, start + MAX_READ_LINES - 1, lines.length);
    if (start > lines.length) return fail(`${input.path} has only ${lines.length} lines`);
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
      .join('\n');
    const more = end < lines.length ? `\n(lines ${end + 1}-${lines.length} not shown)` : '';
    return ok(`${body}${more}`);
  },
};
