/** An immutable text buffer. Every edit returns a new Doc. */
export class Doc {
  readonly text: string;

  constructor(text = '') {
    this.text = text;
  }

  get length(): number {
    return this.text.length;
  }

  insert(pos: number, str: string): Doc {
    const at = clamp(pos, 0, this.length);
    return new Doc(this.text.slice(0, at) + str + this.text.slice(at));
  }

  remove(pos: number, len: number): Doc {
    const from = clamp(pos, 0, this.length);
    const to = clamp(from + len, from, this.length);
    return new Doc(this.text.slice(0, from) + this.text.slice(to));
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
