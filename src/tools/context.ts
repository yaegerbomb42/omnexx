import { z } from 'zod';
import { notesCap, renderScope, SCOPES, writeScopeNotes, type ScopeEnv } from '../agent/scopes.js';
import { ok, type Tool, type ToolContext } from './types.js';

const schema = z.strictObject({
  action: z.enum(['read', 'update']),
  scope: z
    .enum(SCOPES)
    .describe(
      "general: goal, intent, lessons (kept across runs) · repo: codebase map (kept across runs) · heat: files changing most lately · recent: this task's running context",
    ),
  notes: z
    .string()
    .max(notesCap('repo'))
    .optional()
    .describe('update: your whole notes for this scope (replaces the old ones)'),
});

const envOf = (ctx: ToolContext): ScopeEnv => ({
  store: ctx.store,
  repoRoot: ctx.jail.root,
  ...(ctx.runningContext ? { runningContext: ctx.runningContext } : {}),
  edited: ctx.edited,
});

export const contextTool: Tool<typeof schema> = {
  name: 'context',
  description:
    "Pull in one level of context when you need it, from widest to narrowest: general (goal, intent, lessons), repo (codebase map), heat (files changing most lately), recent (this task's running context). Each is capped, so only read what helps. Use update to rewrite your own notes in a scope (architecture you worked out, where things live, the plan in your head) so you keep your bearings after the context is trimmed; general and repo notes carry over to later runs on this repo.",
  schema,
  readOnly: true,
  async run(input, ctx) {
    const env = envOf(ctx);
    if (input.action === 'update') {
      const stored = await writeScopeNotes(env, input.scope, input.notes ?? '');
      ctx.events.emit('context.scope_update', { scope: input.scope, chars: stored.length });
      const clipped = (input.notes ?? '').trim().length > stored.length;
      return ok(
        `${input.scope} notes saved (${stored.length} chars${clipped ? `, clipped to ${notesCap(input.scope)}` : ''})`,
      );
    }
    return ok(ctx.redactor.text(await renderScope(env, input.scope)));
  },
};
