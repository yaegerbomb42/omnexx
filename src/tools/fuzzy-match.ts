/** Whitespace-insensitive line matching for str_replace when the exact text is not found. */

const norm = (line: string): string => line.trim().replace(/\s+/g, ' ');
const indentOf = (line: string): string => /^\s*/.exec(line)?.[0] ?? '';

function trimBlankEdges(lines: readonly string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && norm(lines[a] ?? '') === '') a++;
  while (b > a && norm(lines[b - 1] ?? '') === '') b--;
  return lines.slice(a, b);
}

export type FuzzyResult =
  | { found: 0 }
  | { found: 'many'; lines: number[] }
  | { found: 1; text: string; start: number; end: number; reindented: boolean };

/** 1-based start lines of every window of `fileLines` equal to `needle`, whitespace aside. */
function windows(fileLines: readonly string[], needle: readonly string[]): number[] {
  const want = needle.map(norm);
  const hits: number[] = [];
  for (let s = 0; s + want.length <= fileLines.length; s++) {
    if (want.every((w, k) => norm(fileLines[s + k] ?? '') === w)) hits.push(s + 1);
  }
  return hits;
}

/**
 * Replace the one block of whole lines in `text` that equals `oldStr` once whitespace is
 * normalized, re-indenting `newStr` from `oldStr`'s indentation to the block's.
 */
export function fuzzyReplace(text: string, oldStr: string, newStr: string): FuzzyResult {
  const needle = trimBlankEdges(oldStr.split('\n'));
  if (!needle.length) return { found: 0 };
  const fileLines = text.split('\n');
  const hits = windows(fileLines, needle);
  const [s] = hits;
  if (s === undefined) return { found: 0 };
  if (hits.length > 1) return { found: 'many', lines: hits.slice(0, 10) };
  const from = indentOf(needle[0] ?? '');
  const to = indentOf(fileLines[s - 1] ?? '');
  const body = oldStr.endsWith('\n') && newStr.endsWith('\n') ? newStr.slice(0, -1) : newStr;
  const replacement = body
    .split('\n')
    .map((l) => (from !== to && l.startsWith(from) && l.trim() ? to + l.slice(from.length) : l));
  const end = s + needle.length - 1;
  const out = [...fileLines.slice(0, s - 1), ...replacement, ...fileLines.slice(end)];
  return { found: 1, text: out.join('\n'), start: s, end, reindented: from !== to };
}
