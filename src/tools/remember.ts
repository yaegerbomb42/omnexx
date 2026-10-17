import { z } from 'zod';
import { applyRemember, NOTE_TYPES, rememberInputSchema } from '../core/notes.js';
import { fail, ok, type Tool } from './types.js';

/**
 * The API needs a plain object at the top of every tool schema (no top-level union), so the
 * tool accepts one flat shape and the per-action rules are checked by `rememberInputSchema`.
 */
const schema = z.strictObject({
  action: z.enum(['add', 'replace', 'remove']),
  id: z.string().optional().describe('Lesson id, e.g. "N3"'),
  type: z.enum(NOTE_TYPES).optional().describe('For add'),
  text: z.string().min(1).max(400).optional().describe('For add and replace'),
});

export const rememberTool: Tool<typeof schema> = {
  name: 'remember',
  description:
    'Record a durable repo lesson for later cycles (e.g. "tests need DATABASE_URL"). When the file is full, replace or remove one by id.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    const parsed = rememberInputSchema.safeParse(
      Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
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
