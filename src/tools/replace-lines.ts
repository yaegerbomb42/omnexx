import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { locateRange } from './anchors.js';
import { openError } from './did-you-mean.js';
import { recordEdit } from './edit.js';
import { afterEdit, preWriteSyntaxCheck } from './post-edit.js';
import { fail, ok, resolvePath, type Tool } from './types.js';

const schema = z.strictObject({
  path: z.string(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  expected_hash: z
    .string()
    .regex(
      /^[a-z2-9]{2}(?:[a-z2-9]{2})?$/,
      'use the 2-character tags read shows with anchors: true, start tag then end tag (e.g. "k3pq"), or leave expected_hash out',
    )
    .optional()
    .describe(
      'Start then end line tag from read with anchors: true (e.g. "k3pq"); refuses if those lines changed',
    ),
  new_text: z.string().describe('Replacement lines; empty deletes the range'),
});

/** Replace lines start..end with new_text, checked against the anchors the model read. */
export const replaceLinesTool: Tool<typeof schema> = {
  name: 'replace_lines',
  description:
    'Replace a line range without repeating the old text; read it with anchors: true first.',
  schema,
  readOnly: false,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const rest = { ...raw };
    delete rest.start_line;
    delete rest.end_line;
    delete rest.new_str;
    delete rest.replacement;
    delete rest.text;
    delete rest.content;
    return {
      ...rest,
      start: raw.start ?? raw.start_line,
      end: raw.end ?? raw.end_line,
      new_text: raw.new_text ?? raw.new_str ?? raw.replacement ?? raw.text ?? raw.content,
    };
  },
  async run(input, ctx) {
    let abs: string;
    let text: string;
    try {
      abs = await resolvePath(ctx, input.path, 'write');
      text = await readFile(abs, 'utf8');
    } catch (err) {
      return fail(await openError(ctx, input.path, err));
    }
    if (ctx.contractGate) {
      const check = ctx.contractGate.validateEdit(input.path);
      if (!check.ok) return fail(check.error ?? 'edit rejected by contract gate');
    }
    const lines = text.split('\n');
    const at = locateRange(lines, input.start, input.end, input.expected_hash);
    if (!at.ok) return fail(`${input.path}: ${at.reason}`);
    const body = input.new_text.endsWith('\n') ? input.new_text.slice(0, -1) : input.new_text;
    const replacement = input.new_text === '' ? [] : body.split('\n');
    const out = [...lines.slice(0, at.start - 1), ...replacement, ...lines.slice(at.end)];
    const newText = out.join('\n');
    const syntaxCheck = await preWriteSyntaxCheck(ctx, abs, newText);
    if (!syntaxCheck.ok) return fail(syntaxCheck.error);
    await writeFile(abs, newText);
    recordEdit(ctx, abs);
    const moved = at.moved ? `; the lines had moved, applied at ${at.start}-${at.end}` : '';
    const tail = await afterEdit(ctx, abs, text);
    return ok(
      `replaced lines ${at.start}-${at.end} of ${input.path} with ${replacement.length}${moved}${tail}`,
    );
  },
};
