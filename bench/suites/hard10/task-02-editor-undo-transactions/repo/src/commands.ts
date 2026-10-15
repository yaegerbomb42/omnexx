import type { Doc } from './document.ts';

/** One edit operation. */
export interface Command {
  apply(doc: Doc): Doc;
}

export class InsertCommand implements Command {
  readonly pos: number;
  readonly str: string;

  constructor(pos: number, str: string) {
    this.pos = pos;
    this.str = str;
  }

  apply(doc: Doc): Doc {
    return doc.insert(this.pos, this.str);
  }
}

export class DeleteCommand implements Command {
  readonly pos: number;
  readonly len: number;

  constructor(pos: number, len: number) {
    this.pos = pos;
    this.len = len;
  }

  apply(doc: Doc): Doc {
    return doc.remove(this.pos, this.len);
  }
}
