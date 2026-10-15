import { Doc } from './document.ts';
import { DeleteCommand, InsertCommand, type Command } from './commands.ts';

export type Listener = (text: string) => void;

export interface Editor {
  text(): string;
  insert(pos: number, str: string): void;
  delete(pos: number, len: number): void;
  /** Subscribe to text changes; returns an unsubscribe function. */
  onChange(fn: Listener): () => void;
}

export function createEditor(initial = ''): Editor {
  let doc = new Doc(initial);
  const listeners = new Set<Listener>();

  const run = (cmd: Command): void => {
    doc = cmd.apply(doc);
    for (const fn of listeners) fn(doc.text);
  };

  return {
    text: () => doc.text,
    insert: (pos, str) => run(new InsertCommand(pos, str)),
    delete: (pos, len) => run(new DeleteCommand(pos, len)),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
