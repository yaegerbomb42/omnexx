import { createHash } from 'node:crypto';

/** 32 unambiguous characters: two of them give 1024 tags, plenty next to a line number. */
const ALPHABET = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCodePoint(97 + i)).filter(
    (c) => c !== 'l' && c !== 'o',
  ),
  ...Array.from({ length: 8 }, (_, i) => String(i + 2)),
].join('');

/** A two-character content tag for one line (trailing whitespace ignored). */
export function lineTag(line: string): string {
  const d = createHash('sha256').update(line.trimEnd()).digest();
  return `${ALPHABET[(d[0] ?? 0) & 31]}${ALPHABET[(d[1] ?? 0) & 31]}`;
}

/** The `expected_hash` for lines start..end (1-based): the start line's tag then the end line's. */
export function rangeHash(lines: readonly string[], start: number, end: number): string {
  return `${lineTag(lines[start - 1] ?? '')}${lineTag(lines[end - 1] ?? '')}`;
}

export type Located =
  { ok: true; start: number; end: number; moved: boolean } | { ok: false; reason: string };

/**
 * Where lines start..end with anchor `expected` are now. They match where they were, or, if the
 * file shifted, at the one place the same pair of tags sits the same distance apart.
 */
export function locateRange(
  lines: readonly string[],
  start: number,
  end: number,
  expected: string | undefined,
): Located {
  if (end < start) return { ok: false, reason: `end (${end}) is before start (${start})` };
  if (end > lines.length) return { ok: false, reason: `the file has only ${lines.length} lines` };
  if (expected === undefined) return { ok: true, start, end, moved: false };
  const want = expected.length === 2 ? `${expected}${expected}` : expected;
  if (rangeHash(lines, start, end) === want) return { ok: true, start, end, moved: false };
  const span = end - start;
  const hits: number[] = [];
  for (let s = 1; s + span <= lines.length && hits.length < 2; s++) {
    if (rangeHash(lines, s, s + span) === want) hits.push(s);
  }
  const [only] = hits;
  if (hits.length === 1 && only !== undefined)
    return { ok: true, start: only, end: only + span, moved: true };

  // Fuzzy recovery for 1-line ranges where anchor shifted slightly within nearby window
  if (span === 0 && want.length === 4) {
    const singleTag = want.slice(0, 2);
    const nearbyRadius = 15;
    const minS = Math.max(1, start - nearbyRadius);
    const maxS = Math.min(lines.length, start + nearbyRadius);
    const nearbyHits: number[] = [];
    for (let s = minS; s <= maxS && nearbyHits.length < 2; s++) {
      if (lineTag(lines[s - 1] ?? '') === singleTag) nearbyHits.push(s);
    }
    const [nearbyOnly] = nearbyHits;
    if (nearbyHits.length === 1 && nearbyOnly !== undefined) {
      return { ok: true, start: nearbyOnly, end: nearbyOnly, moved: true };
    }
  }

  const now = rangeHash(lines, start, end);
  const first = JSON.stringify((lines[start - 1] ?? '').trim().slice(0, 80));
  return {
    ok: false,
    reason: `anchor mismatch: lines ${start}-${end} now hash ${now}, not ${want}; line ${start} is now ${first}. Re-read the range with anchors: true and retry. No changes were written.`,
  };
}
