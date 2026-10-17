import { lineTag, rangeHash } from './anchors.js';
import { MAX_LINE_CHARS } from './read.js';

/** Shown region is about as long as old_str, never a whole large file. */
const MAX_SNIPPET_LINES = 40;

const normLine = (line: string): string => line.trim().replace(/\s+/g, ' ');

function trimBlankEdges(lines: readonly string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && normLine(lines[a] ?? '') === '') a++;
  while (b > a && normLine(lines[b - 1] ?? '') === '') b--;
  return lines.slice(a, b);
}

function tokens(line: string): string[] {
  return line.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 0);
}

/** Bigram Dice on whitespace-normalized text. 1 when the strings are equal. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bag = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = `${a[i] ?? ''}${a[i + 1] ?? ''}`;
    bag.set(g, (bag.get(g) ?? 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = `${b[i] ?? ''}${b[i + 1] ?? ''}`;
    const n = bag.get(g) ?? 0;
    if (n > 0) {
      inter++;
      bag.set(g, n - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

function tokenOverlap(needle: readonly string[], window: readonly string[]): number {
  const want = new Map<string, number>();
  let total = 0;
  for (const line of needle) {
    for (const t of tokens(line)) {
      want.set(t, (want.get(t) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return 0;
  const have = new Map<string, number>();
  for (const line of window) {
    for (const t of tokens(line)) have.set(t, (have.get(t) ?? 0) + 1);
  }
  let inter = 0;
  for (const [t, c] of want) inter += Math.min(c, have.get(t) ?? 0);
  return inter / total;
}

export interface ClosestRegion {
  start: number;
  end: number;
}

/**
 * The window of about `oldStr`'s line count whose whitespace-normalized text is closest,
 * breaking ties by token overlap, then the earlier window.
 */
export function closestRegion(text: string, oldStr: string): ClosestRegion {
  const fileLines = text.split('\n');
  const needle = trimBlankEdges(oldStr.split('\n'));
  const width = Math.min(Math.max(needle.length, 1), fileLines.length, MAX_SNIPPET_LINES);
  const probe = (needle.length ? needle : ['']).slice(0, width).map(normLine);
  const probeKey = probe.join('\n');
  const norm = fileLines.map(normLine);
  let bestAt = 0;
  let bestWs = -1;
  let bestTok = -1;
  for (let s = 0; s + width <= fileLines.length; s++) {
    const window = norm.slice(s, s + width);
    const ws = dice(probeKey, window.join('\n'));
    const tok = tokenOverlap(probe, window);
    if (ws > bestWs || (ws === bestWs && tok > bestTok)) {
      bestAt = s;
      bestWs = ws;
      bestTok = tok;
    }
  }
  return { start: bestAt + 1, end: bestAt + width };
}

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}… [line is ${line.length} chars; search for text in it]`;
}

/** Same row `read` prints with `anchors: true`: padded line number, then `lineTag`. */
function anchoredRow(n: number, line: string): string {
  return `${String(n).padStart(5)} ${lineTag(line)} ${clipLine(line)}`;
}

/** Error text for a str_replace that matched nothing. First line is machine-readable. */
export function missText(index: number, path: string, text: string, oldStr: string): string {
  const lines = text.split('\n');
  const region = closestRegion(text, oldStr);
  const hash = rangeHash(lines, region.start, region.end);
  const body = lines
    .slice(region.start - 1, region.end)
    .map((line, i) => anchoredRow(region.start + i, line))
    .join('\n');
  return [
    'miss: true',
    `edit ${index}: old_str did not match in ${path}. No changes were written. Closest lines are ${region.start}-${region.end}; replace_lines can use expected_hash ${hash} (the tags shown).`,
    body,
  ].join('\n');
}
