import type { Doc } from './document.ts';
import { clamp } from './document.ts';

/** One applied edit: the document after it, and the edit that undoes it. */
export interface Applied {
  doc: Doc;
  inverse: Command;
}

/** One edit operation. */
export interface Command {
  apply(doc: Doc): Applied;
}

export class InsertCommand implements Command {
  readonly pos: number;
  readonly str: string;

  constructor(pos: number, str: string) {
    this.pos = pos;
    this.str = str;
  }

  apply(doc: Doc): Applied {
    const at = clamp(this.pos, 0, doc.length);
    return { doc: doc.insert(at, this.str), inverse: new DeleteCommand(at, this.str.length) };
  }
}

export class DeleteCommand implements Command {
  readonly pos: number;
  readonly len: number;

  constructor(pos: number, len: number) {
    this.pos = pos;
    this.len = len;
  }

  apply(doc: Doc): Applied {
    const from = clamp(this.pos, 0, doc.length);
    const removed = doc.text.slice(from, clamp(from + this.len, from, doc.length));
    return { doc: doc.remove(from, removed.length), inverse: new InsertCommand(from, removed) };
  }
}
