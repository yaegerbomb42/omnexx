import { z } from 'zod';
import { ok, type Tool } from './types.js';

export const TODO_STATUS = ['pending', 'in_progress', 'done'] as const;

const schema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(200),
        status: z.enum(TODO_STATUS),
      }),
    )
    .max(30)
    .describe('The whole list, in order. Send it again with updated statuses as you go.'),
});

export type TodoItem = z.infer<typeof schema>['items'][number];

function normalizeTodo(input: unknown): unknown {
  // Models often send `done: true` or `completed` instead of a status.
  if (typeof input !== 'object' || input === null) return input;
  const items = (input as { items?: unknown }).items;
  if (!Array.isArray(items)) return input;
  return {
    items: items.map((raw: unknown) => {
      if (typeof raw === 'string') return { text: raw, status: 'pending' };
      if (typeof raw !== 'object' || raw === null) return raw;
      const it = raw as Record<string, unknown>;
      const st = (
        typeof it.status === 'string' ? it.status : it.done === true ? 'done' : 'pending'
      ).toLowerCase();
      return {
        text: it.text ?? it.content ?? it.title ?? '',
        status:
          st === 'completed' || st === 'complete'
            ? 'done'
            : st === 'in-progress'
              ? 'in_progress'
              : st,
      };
    }),
  };
}

/** The items of a todo call's raw input, normalized; undefined when it isn't a valid list. */
export function todoItemsOf(input: unknown): TodoItem[] | undefined {
  const parsed = schema.safeParse(normalizeTodo(input));
  return parsed.success ? parsed.data.items : undefined;
}

/** The one reminder a model gets when it stops with unchecked items. */
export function todoNudge(open: readonly TodoItem[]): string {
  return `Your todo list still has open items:\n${open.map((i) => `- ${i.text}`).join('\n')}\n\nFinish them now, or if one turned out not to be needed, update the todo list to drop it and say why. Then reply with your summary.`;
}

/**
 * The agent's checklist for the current request, shown to the person as checkboxes. Each call
 * replaces the list; the TUI renders the latest `todo.update` event.
 */
export const todoTool: Tool<typeof schema> = {
  name: 'todo',
  description:
    'Keep a short checklist of the steps for the current request, shown to the user. Write it before multi-step work, mark one item in_progress at a time, and mark items done as you finish them. Skip it for one-step requests.',
  schema,
  readOnly: true,
  normalize: normalizeTodo,
  run(input, ctx) {
    ctx.events.emit('todo.update', { items: input.items });
    const done = input.items.filter((i) => i.status === 'done').length;
    return Promise.resolve(ok(`todo list updated (${done}/${input.items.length} done)`));
  },
};
