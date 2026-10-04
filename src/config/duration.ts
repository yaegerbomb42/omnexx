import { z } from 'zod';

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"` or `"1h30m"` into milliseconds. */
export function parseDuration(input: string): number {
  const text = input.trim();
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [whole, amount, unit] = match;
    total += Number(amount) * (UNITS[unit ?? ''] ?? Number.NaN);
    consumed += whole.length;
  }
  if (text.length === 0 || consumed !== text.length || !Number.isFinite(total)) {
    throw new Error(`invalid duration "${input}" (use e.g. "30s", "5m", "2h", "1h30m")`);
  }
  return total;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

/** A zod string that must parse as a duration. The config keeps the string; callers parse it. */
export const durationString = z.string().refine(
  (v) => {
    try {
      parseDuration(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'expected a duration like "30s", "5m" or "2h"' },
);
