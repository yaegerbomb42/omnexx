import { applyRemember, rememberInputSchema } from '../core/notes.js';
import { fail, ok, type Tool } from './types.js';

export const rememberTool: Tool<typeof rememberInputSchema> = {
  name: 'remember',
  description:
    'Record a durable lesson about this repo for future cycles (e.g. "tests need DATABASE_URL", "use pnpm"). Types: env, convention, pitfall, command, flaky. The file is capped: when full, replace or remove an entry by id. Changes take effect next cycle.',
  schema: rememberInputSchema,
  readOnly: true,
  async run(input, ctx) {
    const notes = await ctx.store.readNotes();
    const r = applyRemember(notes, input, ctx.notesMaxTokens, ctx.today);
    if (!r.ok) return fail(r.message);
    await ctx.store.writeNotes(r.notes);
    ctx.events.emit('notes.update', { action: input.action, count: r.notes.length });
    return ok(r.message);
  },
};
