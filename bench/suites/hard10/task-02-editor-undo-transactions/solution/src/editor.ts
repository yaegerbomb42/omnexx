import { Doc } from './document.ts';
import { DeleteCommand, InsertCommand, type Command } from './commands.ts';
import { History } from './history.ts';

export type Listener = (text: string) => void;

export interface Editor {
  text(): string;
  insert(pos: number, str: string): void;
  delete(pos: number, len: number): void;
  onChange(fn: Listener): () => void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  transaction(fn: () => void): void;
}

export interface EditorOptions {
  historyLimit?: number;
}

interface Pending {
  start: Doc;
  forward: Command[];
  backward: Command[];
}

export function createEditor(initial = '', options: EditorOptions = {}): Editor {
  let doc = new Doc(initial);
  const listeners = new Set<Listener>();
  const history = new History(options.historyLimit ?? 100);
  let pending: Pending | null = null;
  let depth = 0;

  const notify = (): void => {
    for (const fn of listeners) fn(doc.text);
  };

  const replay = (cmds: readonly Command[]): void => {
    for (const c of cmds) doc = c.apply(doc).doc;
  };

  const transaction = (fn: () => void): void => {
    if (depth > 0) {
      depth++;
      try {
        fn();
      } finally {
        depth--;
      }
      return;
    }
    pending = { start: doc, forward: [], backward: [] };
    depth = 1;
    try {
      fn();
    } catch (err) {
      doc = pending.start;
      throw err;
    } finally {
      depth = 0;
    }
    const step = pending;
    pending = null;
    if (step.forward.length === 0 || step.start.text === doc.text) return;
    history.record({ forward: step.forward, backward: [...step.backward].reverse() });
    notify();
  };

  const run = (cmd: Command): void => {
    const { doc: next, inverse } = cmd.apply(doc);
    if (next.text === doc.text) return;
    transaction(() => {
      doc = next;
      pending?.forward.push(cmd);
      pending?.backward.push(inverse);
    });
  };

  const move = (step: ReturnType<History['takeUndo']>, cmds: 'forward' | 'backward'): boolean => {
    if (!step) return false;
    replay(step[cmds]);
    notify();
    return true;
  };

  return {
    text: () => doc.text,
    insert: (pos, str) => run(new InsertCommand(pos, str)),
    delete: (pos, len) => run(new DeleteCommand(pos, len)),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    undo: () => move(history.takeUndo(), 'backward'),
    redo: () => move(history.takeRedo(), 'forward'),
    canUndo: () => history.canUndo,
    canRedo: () => history.canRedo,
    transaction,
  };
}
