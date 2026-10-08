import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A model that reported "out of quota" is skipped this long (quotas usually reset daily). */
export const EXHAUSTED_FOR_MS = 24 * 3_600_000;

/**
 * Which provider:model refs are out of quota, shared by every run and chat through one file, so a
 * model that ran dry in one session isn't hit again in the next. Reads are cheap and fresh: the
 * file is re-read on each check so parallel sessions see each other's marks.
 */
export class QuotaLedger {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Record<string, number> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { exhausted?: unknown };
      const ex = raw.exhausted;
      if (!ex || typeof ex !== 'object') return {};
      const t = this.now();
      return Object.fromEntries(
        Object.entries(ex as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === 'number' && t - e[1] < EXHAUSTED_FOR_MS,
        ),
      );
    } catch {
      return {};
    }
  }

  /** When `ref` ran out, if it is still within the reset window. */
  exhaustedAt(ref: string): number | undefined {
    return this.read()[ref];
  }

  all(): Record<string, number> {
    return this.read();
  }

  mark(ref: string): void {
    this.write({ ...this.read(), [ref]: this.now() });
  }

  clear(ref?: string): void {
    this.write(
      ref ? Object.fromEntries(Object.entries(this.read()).filter(([r]) => r !== ref)) : {},
    );
  }

  private write(exhausted: Record<string, number>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ exhausted }, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch {
      // A ledger we can't write only means the model may be tried again later.
    }
  }
}
