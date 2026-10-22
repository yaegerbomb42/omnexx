import { z } from 'zod';
import { applyRemember, NOTE_TYPES, rememberInputSchema } from '../core/notes.js';
import { fail, ok, type Tool } from './types.js';

/**
 * The API needs a plain object at the top of every tool schema (no top-level union), so the
 * tool accepts one flat shape and the per-action rules are checked by `rememberInputSchema`.
 */
const schema = z.strictObject({
  action: z
    .enum(['add', 'replace', 'remove'])
    .optional()
    .describe('Action to perform (default: "add")'),
  id: z.string().optional().describe('Lesson id, e.g. "N3"'),
  type: z.enum(NOTE_TYPES).optional().describe('Category for add (default: "convention")'),
  text: z.string().min(1).max(400).optional().describe('For add and replace'),
});

function inferType(text: string): (typeof NOTE_TYPES)[number] {
  const lower = text.toLowerCase();
  if (
    lower.includes('env') ||
    lower.includes('path') ||
    lower.includes('url') ||
    lower.includes('token') ||
    lower.includes('key')
  )
    return 'env';
  if (lower.includes('test') || lower.includes('flaky') || lower.includes('timeout'))
    return 'flaky';
  if (
    lower.includes('run') ||
    lower.includes('command') ||
    lower.includes('npm') ||
    lower.includes('bash') ||
    lower.includes('node') ||
    lower.includes('git')
  )
    return 'command';
  if (
    lower.includes('fail') ||
    lower.includes('bug') ||
    lower.includes('issue') ||
    lower.includes('warn') ||
    lower.includes('pitfall') ||
    lower.includes('avoid')
  )
    return 'pitfall';
  return 'convention';
}

function normalizeRemember(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const raw = input as Record<string, unknown>;
  const textVal = raw.text ?? raw.content ?? raw.note ?? raw.lesson ?? raw.fact ?? raw.message;
  const text = typeof textVal === 'string' ? textVal.trim() : undefined;
  const idVal = raw.id ?? raw.key ?? raw.num;
  const id =
    typeof idVal === 'string' ? idVal.trim() : typeof idVal === 'number' ? `N${idVal}` : undefined;

  let action = typeof raw.action === 'string' ? raw.action.toLowerCase() : undefined;
  if (!action) {
    if (id && !text) action = 'remove';
    else if (id && text) action = 'replace';
    else action = 'add';
  }

  let type =
    typeof raw.type === 'string'
      ? (raw.type.toLowerCase() as (typeof NOTE_TYPES)[number])
      : undefined;
  if (action === 'add' && (!type || !NOTE_TYPES.includes(type))) {
    type = text ? inferType(text) : 'convention';
  }

  return {
    action,
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
    ...(text ? { text: text.slice(0, 400) } : {}),
  };
}

export const rememberTool: Tool<typeof schema> = {
  name: 'remember',
  description:
    'Record a durable repo lesson for later cycles (e.g. "tests need DATABASE_URL"). When the file is full, replace or remove one by id.',
  schema,
  readOnly: true,
  normalize: normalizeRemember,
  async run(input, ctx) {
    const normalized = normalizeRemember(input) as Record<string, unknown>;
    const parsed = rememberInputSchema.safeParse(
      Object.fromEntries(Object.entries(normalized).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) {
      return fail(
        'invalid remember call: add needs type and text; replace needs id and text; remove needs id',
      );
    }
    const notes = await ctx.store.readNotes();
    const r = applyRemember(notes, parsed.data, ctx.notesMaxTokens, ctx.today);
    if (!r.ok) return fail(r.message);
    await ctx.store.writeNotes(r.notes);
    ctx.events.emit('notes.update', { action: parsed.data.action, count: r.notes.length });
    return ok(r.message);
  },
};
