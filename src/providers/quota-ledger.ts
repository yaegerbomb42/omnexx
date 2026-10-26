import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A model that reported "out of quota" is skipped this long (quotas usually reset daily). */
export const EXHAUSTED_FOR_MS = 24 * 3_600_000;

interface LedgerFile {
  /** ref → when it ran out of quota (out for EXHAUSTED_FOR_MS). */
  exhausted: Record<string, number>;
  /** ref → until when it is rate-limited (shorter marks, set by fallback lists). */
  limited: Record<string, number>;
}

function numbers(value: unknown, keep: (n: number) => boolean): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === 'number' && keep(e[1]),
    ),
  );
}

/**
 * Which provider:model refs are out of quota (or briefly rate-limited), shared by every run and
 * chat through one file, so a model that ran dry in one session isn't hit again in the next.
 * Reads are cheap and fresh: the file is re-read on each check so parallel sessions see each
 * other's marks.
 */
export class QuotaLedger {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): LedgerFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const t = this.now();
      return {
        exhausted: numbers(raw.exhausted, (at) => t - at < EXHAUSTED_FOR_MS),
        limited: numbers(raw.limited, (until) => until > t),
      };
    } catch {
      return { exhausted: {}, limited: {} };
    }
  }

  /** When `ref` ran out, if it is still within the reset window. */
  exhaustedAt(ref: string): number | undefined {
    return this.read().exhausted[ref];
  }

  /** Whether `ref` should be skipped now: out of quota or rate-limited. */
  isOut(ref: string): boolean {
    const r = this.read();
    return r.exhausted[ref] !== undefined || r.limited[ref] !== undefined;
  }

  /** Whether `ref` is only briefly rate-limited (not out of quota). */
  isLimited(ref: string): boolean {
    return this.read().limited[ref] !== undefined;
  }

  /** When `ref`'s rate-limit expires, if it is still limited. */
  limitedUntil(ref: string): number | undefined {
    return this.read().limited[ref];
  }

  /** Out-of-quota refs and when they ran out. */
  all(): Record<string, number> {
    return this.read().exhausted;
  }

  /** All refs sorted by when they become available (most available first). */
  sortedByAvailability(): { ref: string; availableAt: number }[] {
    const r = this.read();
    const all: { ref: string; availableAt: number }[] = [
      ...Object.entries(r.exhausted).map(([ref, at]) => ({ ref, availableAt: at })),
      ...Object.entries(r.limited).map(([ref, until]) => ({ ref, availableAt: until })),
    ];
    return all.sort((a, b) => a.availableAt - b.availableAt);
  }

  /** Mark `ref` out of quota, or rate-limited for `forMs` when given. */
  mark(ref: string, forMs?: number): void {
    const r = this.read();
    this.write(
      forMs === undefined
        ? { ...r, exhausted: { ...r.exhausted, [ref]: this.now() } }
        : { ...r, limited: { ...r.limited, [ref]: this.now() + forMs } },
    );
  }

  clear(ref?: string): void {
    const r = this.read();
    const drop = (m: Record<string, number>): Record<string, number> =>
      ref ? Object.fromEntries(Object.entries(m).filter(([x]) => x !== ref)) : {};
    this.write({ exhausted: drop(r.exhausted), limited: drop(r.limited) });
  }

  private write(data: LedgerFile): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch {
      // A ledger we can't write only means the model may be tried again later.
    }
  }
}
