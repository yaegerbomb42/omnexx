import { z } from 'zod';
import { estimateTokens } from './tokens.js';

/** The lessons file (plan §14.2): typed, dated, capped entries edited only through `remember`. */
export const NOTE_TYPES = ['env', 'convention', 'pitfall', 'command', 'flaky'] as const;

export const noteSchema = z.strictObject({
  id: z.string().regex(/^N\d+$/),
  type: z.enum(NOTE_TYPES),
  text: z.string().min(1).max(400),
  date: z.string(),
});
export type Note = z.infer<typeof noteSchema>;
export const notesSchema = z.array(noteSchema);

export const rememberInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('add'),
    type: z.enum(NOTE_TYPES),
    text: z.string().min(1).max(400),
  }),
  z.strictObject({
    action: z.literal('replace'),
    id: z.string(),
    type: z.enum(NOTE_TYPES).optional(),
    text: z.string().min(1).max(400),
  }),
  z.strictObject({ action: z.literal('remove'), id: z.string() }),
]);
export type RememberInput = z.infer<typeof rememberInputSchema>;

export function renderNotes(notes: readonly Note[]): string {
  if (!notes.length) return '(no lessons recorded yet)';
  return notes.map((n) => `- [${n.id}] (${n.type}, ${n.date}) ${n.text}`).join('\n');
}

export type RememberResult =
  { ok: true; notes: Note[]; message: string } | { ok: false; message: string };

/** Apply one remember call. When the file is full, the agent must replace or remove instead of growing it. */
export function applyRemember(
  notes: readonly Note[],
  input: RememberInput,
  maxTokens: number,
  today: string,
): RememberResult {
  let next: Note[];
  if (input.action === 'add') {
    const n = notes.reduce((m, x) => Math.max(m, Number(x.id.slice(1))), 0) + 1;
    next = [...notes, { id: `N${n}`, type: input.type, text: input.text, date: today }];
  } else {
    const idx = notes.findIndex((x) => x.id === input.id);
    if (idx < 0)
      return {
        ok: false,
        message: `no lesson ${input.id}; existing: ${notes.map((x) => x.id).join(', ') || 'none'}`,
      };
    if (input.action === 'remove') next = notes.filter((_, i) => i !== idx);
    else {
      const old = notes[idx];
      if (!old) return { ok: false, message: `no lesson ${input.id}` };
      next = notes.map((x, i) =>
        i === idx ? { ...old, type: input.type ?? old.type, text: input.text, date: today } : x,
      );
    }
  }
  const size = estimateTokens(renderNotes(next));
  if (input.action !== 'remove' && size > maxTokens) {
    return {
      ok: false,
      message: `lessons file is full (${size} > ${maxTokens} tokens). Replace or remove an existing entry first.`,
    };
  }
  return {
    ok: true,
    notes: next,
    message: `${input.action} ok; ${next.length} lessons, ~${size} tokens. Takes effect next cycle.`,
  };
}
