/**
 * The composer's suggestion list: `/` at the start of the input offers commands, `@` before the
 * caret offers workspace files. Arrow keys move, Enter or Tab accepts, Escape closes.
 */
export interface SlashCommand {
  name: string;
  hint: string;
  /** A panel action (`runAction`) or a mode, run when the command is picked. */
  run: { action: string } | { mode: 'chat' | 'plan' | 'run' };
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: 'new', hint: 'Start a fresh conversation', run: { action: 'clear' } },
  { name: 'plan', hint: 'Plan without editing', run: { mode: 'plan' } },
  { name: 'run', hint: 'Start a long run in the background', run: { mode: 'run' } },
  { name: 'chat', hint: 'Back to turn-by-turn chat', run: { mode: 'chat' } },
  {
    name: 'undo',
    hint: "Put back the files your last message's edits changed",
    run: { action: 'undo' },
  },
  {
    name: 'compact',
    hint: 'Summarize the conversation to free context',
    run: { action: 'compact' },
  },
  { name: 'model', hint: 'Switch the chat model', run: { action: 'pickModel' } },
  { name: 'context', hint: 'See what the model gets', run: { action: 'inspect' } },
  { name: 'settings', hint: 'Open settings', run: { action: 'settings' } },
  { name: 'approve', hint: 'Toggle auto-approve', run: { action: 'approval' } },
  { name: 'trace', hint: 'Toggle the per-turn trace', run: { action: 'trace' } },
];

export type Trigger =
  { kind: 'command'; query: string } | { kind: 'file'; query: string; start: number };

/** What the text before the caret asks for, if anything. */
export function triggerAt(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const slash = /^\/([\w-]*)$/.exec(before);
  if (slash) return { kind: 'command', query: slash[1] ?? '' };
  const at = /(^|\s)@([\w./@-]*)$/.exec(before);
  if (at) return { kind: 'file', query: at[2] ?? '', start: caret - (at[2]?.length ?? 0) - 1 };
  return null;
}

/**
 * Files whose path contains the query's characters in order: an exact name first (`plan` finds
 * `plan.ts`), then name prefixes, substrings, scattered matches; shorter paths break ties.
 */
export function rankFiles(files: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const scored: [number, string][] = [];
  for (const f of files) {
    const p = f.toLowerCase();
    const base = p.slice(p.lastIndexOf('/') + 1);
    let score: number;
    if (!q) score = 4;
    else if (base === q || base.startsWith(`${q}.`)) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (p.includes(q)) score = 2;
    else if (inOrder(p, q)) score = 3;
    else continue;
    scored.push([score * 1000 + Math.min(f.length, 999), f]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, f]) => f);
}

function inOrder(text: string, q: string): boolean {
  let i = 0;
  for (const c of text) if (c === q[i]) i++;
  return i === q.length;
}

export function rankCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}
