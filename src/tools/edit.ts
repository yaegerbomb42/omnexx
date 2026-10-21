import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { openError } from './did-you-mean.js';
import { missText } from './edit-recovery.js';
import { fuzzyReplace } from './fuzzy-match.js';
import { afterEdit } from './post-edit.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from './types.js';

/** 1-based line numbers where `needle` starts in `text` (the first ten). */
function linesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let at = text.indexOf(needle);
  while (at >= 0 && out.length < 10) {
    out.push(text.slice(0, at).split('\n').length);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

export const WRITE_MAX_LINES = 250;

const editSchema = z.strictObject({ old_str: z.string().min(1), new_str: z.string() });

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

type OneResult = { text: string; note?: string } | { error: string; miss?: true };

/** One edit: an exact unique match, else a unique whitespace-insensitive one, else an error. */
function applyOne(
  text: string,
  e: z.infer<typeof editSchema>,
  index: number,
  path: string,
): OneResult {
  const n = countOccurrences(text, e.old_str);
  if (n === 1) return { text: text.replace(e.old_str, () => e.new_str) };
  if (n === 0) {
    const fuzzy = fuzzyReplace(text, e.old_str, e.new_str);
    if (fuzzy.found === 1) {
      const re = fuzzy.reindented ? ', new_str re-indented' : '';
      const note = `edit ${index} matched lines ${fuzzy.start}-${fuzzy.end} ignoring whitespace${re}`;
      return { text: fuzzy.text, note };
    }
    if (fuzzy.found === 0) return { error: missText(index, path, text, e.old_str), miss: true };
    return ambiguous(index, path, `${fuzzy.lines.length} times ignoring whitespace`, fuzzy.lines);
  }
  return ambiguous(index, path, `${n} times`, linesOf(text, e.old_str));
}

function ambiguous(
  index: number,
  path: string,
  count: string,
  lines: readonly number[],
): OneResult {
  const where = lines.length ? ` (at lines ${lines.join(', ')})` : '';
  return {
    error: `edit ${index}: old_str found ${count} in ${path}${where}; it must match exactly once: add a line before or after that only the one you mean has. No changes were written.`,
  };
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
    return fail(await openError(ctx, path, err, 'Use write_file for new files.'));
  }
  const before = text;
  const notes: string[] = [];
  for (const [i, e] of edits.entries()) {
    const r = applyOne(text, e, i + 1, path);
    if ('error' in r)
      return r.miss ? { content: r.error, isError: true, miss: true } : fail(r.error);
    text = r.text;
    if (r.note) notes.push(r.note);
  }
  await writeFile(abs, text);
  recordEdit(ctx, abs);
  const how = notes.length ? `; ${notes.join('; ')}` : '';
  const tail = await afterEdit(ctx, abs, before);
  return ok(
    `edited ${path} (${edits.length} replacement${edits.length > 1 ? 's' : ''}${how})${tail}`,
  );
}

const strReplaceSchema = z.strictObject({
  path: z.string(),
  old_str: z
    .string()
    .min(1)
    .describe('Text to replace; must occur once (whitespace/indent drift is tolerated)'),
  new_str: z.string(),
});

/** Names models use for an edit's old and new text, mapped to old_str / new_str. */
const EDIT_KEY_ALIASES: Readonly<Record<string, string>> = {
  old_string: 'old_str',
  oldText: 'old_str',
  old_text: 'old_str',
  old: 'old_str',
  search: 'old_str',
  find: 'old_str',
  before: 'old_str',
  new_string: 'new_str',
  newText: 'new_str',
  new_text: 'new_str',
  new: 'new_str',
  replace: 'new_str',
  replacement: 'new_str',
  after: 'new_str',
};

export const strReplaceTool: Tool<typeof strReplaceSchema> = {
  name: 'str_replace',
  description: 'Replace one exact, unique snippet in a file. Prefer this over rewriting files.',
  schema: strReplaceSchema,
  readOnly: false,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const inner =
      Array.isArray(raw.edits) && raw.edits[0] && typeof raw.edits[0] === 'object'
        ? (raw.edits[0] as Record<string, unknown>)
        : undefined;
    const source = inner ? { ...raw, ...inner } : raw;
    return Object.fromEntries(
      Object.entries(source)
        .filter(([k]) => k !== 'edits')
        .map(([k, v]) => [EDIT_KEY_ALIASES[k] ?? k, v]),
    );
  },
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
        return Object.fromEntries(
          Object.entries(e)
            .filter(([k]) => k !== 'path')
            .map(([k, v]) => [EDIT_KEY_ALIASES[k] ?? k, v]),
        );
      }),
    };
  },
  run: (input, ctx) => applyEdits(input.path, input.edits, ctx),
};

const writeSchema = z.strictObject({ path: z.string(), content: z.string() });

export const writeFileTool: Tool<typeof writeSchema> = {
  name: 'write_file',
  description: `Create a new file (including when renaming, moving, or splitting modules), or overwrite a file shorter than ${WRITE_MAX_LINES} lines. To modify existing files with more than ${WRITE_MAX_LINES} lines, use str_replace or multi_edit.`,
  schema: writeSchema,
  readOnly: false,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const content =
      raw.content ?? raw.contents ?? raw.text ?? raw.code ?? raw.file_text ?? raw.body;
    if (content === undefined) return input;
    const rest = { ...raw };
    delete rest.contents;
    delete rest.text;
    delete rest.code;
    delete rest.file_text;
    delete rest.body;
    return { ...rest, content };
  },
  async run(input, ctx) {
    let abs: string;
    try {
      abs = await resolvePath(ctx, input.path, 'write');
    } catch (err) {
      return fail(err instanceof OmnexxError ? err.message : String(err));
    }
    let before = '';
    try {
      const existing = await readFile(abs, 'utf8');
      before = existing;
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
    recordEdit(ctx, abs);
    const tail = await afterEdit(ctx, abs, before);
    return ok(`wrote ${input.path} (${input.content.split('\n').length} lines)${tail}`);
  },
};

/** Note a successful edit: the file joins `edited`, and every edit (repeat ones too) is counted. */
export function recordEdit(ctx: ToolContext, abs: string): void {
  const rel = ctx.jail.relative(abs);
  ctx.edited.add(rel);
  ctx.onEdit?.(rel);
}
