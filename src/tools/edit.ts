import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from './types.js';

export const WRITE_MAX_LINES = 50;

const editSchema = z.strictObject({ old_str: z.string().min(1), new_str: z.string() });

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Apply edits in order to an in-memory copy; nothing is written unless every edit applies. */
async function applyEdits(
  path: string,
  edits: readonly z.infer<typeof editSchema>[],
  ctx: ToolContext,
): Promise<ToolOutput> {
  let abs: string;
  let text: string;
  try {
    abs = await resolvePath(ctx, path, 'write');
    text = await readFile(abs, 'utf8');
  } catch (err) {
    return fail(
      err instanceof OmnexxError
        ? err.message
        : `cannot open ${path}: ${(err as NodeJS.ErrnoException).code ?? ''}. Use write_file for new files.`,
    );
  }
  for (const [i, e] of edits.entries()) {
    const n = countOccurrences(text, e.old_str);
    if (n !== 1) {
      return fail(
        `edit ${i + 1}: old_str found ${n} times in ${path}; it must match exactly once (include more surrounding lines). No changes were written.`,
      );
    }
    text = text.replace(e.old_str, () => e.new_str);
  }
  await writeFile(abs, text);
  ctx.edited.add(ctx.jail.relative(abs));
  return ok(`edited ${path} (${edits.length} replacement${edits.length > 1 ? 's' : ''})`);
}

const strReplaceSchema = z.strictObject({
  path: z.string(),
  old_str: z.string().min(1).describe('Exact text to replace; must occur exactly once'),
  new_str: z.string(),
});

export const strReplaceTool: Tool<typeof strReplaceSchema> = {
  name: 'str_replace',
  description: 'Replace one exact, unique snippet in a file. Prefer this over rewriting files.',
  schema: strReplaceSchema,
  readOnly: false,
  run: (input, ctx) => applyEdits(input.path, [input], ctx),
};

const multiSchema = z.strictObject({ path: z.string(), edits: z.array(editSchema).min(1).max(30) });

export const multiEditTool: Tool<typeof multiSchema> = {
  name: 'multi_edit',
  description: 'Apply several str_replace edits to one file atomically (all or nothing), in order.',
  schema: multiSchema,
  readOnly: false,
  // Models often repeat `path` inside each edit instead of once at the top: hoist it.
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const i = input as { path?: unknown; edits?: unknown };
    if (!Array.isArray(i.edits)) return input;
    const inner = i.edits.find(
      (e): e is { path: string } =>
        typeof e === 'object' && e !== null && typeof (e as { path?: unknown }).path === 'string',
    );
    return {
      ...i,
      path: i.path ?? inner?.path,
      edits: i.edits.map((e: unknown) => {
        if (typeof e !== 'object' || e === null) return e;
        return Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'path'));
      }),
    };
  },
  run: (input, ctx) => applyEdits(input.path, input.edits, ctx),
};

const writeSchema = z.strictObject({ path: z.string(), content: z.string() });

export const writeFileTool: Tool<typeof writeSchema> = {
  name: 'write_file',
  description: `Create a new file, or overwrite a file shorter than ${WRITE_MAX_LINES} lines. Use str_replace for edits to larger files.`,
  schema: writeSchema,
  readOnly: false,
  async run(input, ctx) {
    let abs: string;
    try {
      abs = await resolvePath(ctx, input.path, 'write');
    } catch (err) {
      return fail(err instanceof OmnexxError ? err.message : String(err));
    }
    try {
      const existing = await readFile(abs, 'utf8');
      if (existing.split('\n').length > WRITE_MAX_LINES) {
        return fail(
          `${input.path} has more than ${WRITE_MAX_LINES} lines; use str_replace or multi_edit instead of rewriting it`,
        );
      }
    } catch {
      // new file
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content);
    ctx.edited.add(ctx.jail.relative(abs));
    return ok(`wrote ${input.path} (${input.content.split('\n').length} lines)`);
  },
};
