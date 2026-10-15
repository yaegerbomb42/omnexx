/**
 * Turns ripgrep's `path:line:text` / `path-line-text` output into the cheapest form that still
 * answers the search: a few matches keep their context, more matches lose it, and a wide search
 * becomes an overview (files, counts, the first match each) that points at where to look next.
 * Paths are printed once per file instead of on every line.
 */

/** Up to this many matches keep their surrounding context lines. */
export const CONTEXT_MAX = 12;
/** Up to this many matches are all listed; beyond it the result is an overview. */
export const LIST_MAX = 40;
/** Files shown in an overview. */
const OVERVIEW_FILES = 25;
/** A matched line in an overview is cut to this many characters. */
const OVERVIEW_LINE_CHARS = 120;

interface Hit {
  file: string;
  line: number;
  text: string;
  match: boolean;
}

const MATCH = /^(.+?):(\d+):(.*)$/;
const CONTEXT = /^(.+?)-(\d+)-(.*)$/;

/** A context line `file-12-text`, read against the files the matches named (names may hold -2-). */
function parseContext(raw: string, files: ReadonlySet<string>): Hit | undefined {
  for (const file of files) {
    const m = raw.startsWith(`${file}-`) ? /^(\d+)-(.*)$/.exec(raw.slice(file.length + 1)) : null;
    if (m) return { file, line: Number(m[1]), text: m[2] ?? '', match: false };
  }
  const m = CONTEXT.exec(raw);
  return m ? { file: m[1] ?? '', line: Number(m[2]), text: m[3] ?? '', match: false } : undefined;
}

/** `path\0` + `12:text` / `12-text` (rg --null): no ambiguity about where the path ends. */
function parseNul(raw: string): Hit | undefined {
  const at = raw.indexOf('\0');
  const m = /^(\d+)([:-])(.*)$/.exec(raw.slice(at + 1));
  if (!m) return undefined;
  return { file: raw.slice(0, at), line: Number(m[1]), text: m[3] ?? '', match: m[2] === ':' };
}

function parseAll(lines: readonly string[]): Hit[] {
  const clean = lines.map((l) => l.replace(/^\.\//, ''));
  if (clean.some((l) => l.includes('\0')))
    return clean.map(parseNul).filter((h): h is Hit => h !== undefined);
  const matches = new Map<string, Hit>();
  for (const raw of clean) {
    const m = MATCH.exec(raw);
    if (m)
      matches.set(raw, { file: m[1] ?? '', line: Number(m[2]), text: m[3] ?? '', match: true });
  }
  const files = new Set([...matches.values()].map((h) => h.file));
  return clean
    .map((raw) => matches.get(raw) ?? parseContext(raw, files))
    .filter((h): h is Hit => h !== undefined);
}

function byFile(hits: readonly Hit[]): Map<string, Hit[]> {
  const groups = new Map<string, Hit[]>();
  for (const h of hits) groups.set(h.file, [...(groups.get(h.file) ?? []), h]);
  return groups;
}

function grouped(hits: readonly Hit[], withContext: boolean): string {
  const kept = withContext ? hits : hits.filter((h) => h.match);
  const width = String(Math.max(...kept.map((h) => h.line))).length;
  const out: string[] = [];
  for (const [file, rows] of byFile(kept)) {
    out.push(file);
    for (const r of rows)
      out.push(`  ${String(r.line).padStart(width)}${r.match ? ':' : '-'}${r.text}`);
  }
  return out.join('\n');
}

function overview(matches: readonly Hit[]): string {
  const files = [...byFile(matches)].sort((a, b) => b[1].length - a[1].length);
  const shown = files.slice(0, OVERVIEW_FILES).map(([file, rows]) => {
    const first = rows[0];
    const text = (first?.text ?? '').trim().slice(0, OVERVIEW_LINE_CHARS);
    return `${file} (${String(rows.length)})  ${String(first?.line ?? 0)}:  ${text}`;
  });
  const more = files.length - shown.length;
  return [
    `${String(matches.length)} matches in ${String(files.length)} files (too many to list; most first):`,
    ...shown,
    ...(more > 0 ? [`… and ${String(more)} more files`] : []),
    'To see the matches, narrow with path or glob, or search a more specific pattern.',
  ].join('\n');
}

/** Matches per file, for the "has more than N matches" note. */
export function matchCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const h of parseAll(lines)) if (h.match) counts.set(h.file, (counts.get(h.file) ?? 0) + 1);
  return counts;
}

export function formatHits(lines: readonly string[]): string {
  const hits = parseAll(lines);
  const matches = hits.filter((h) => h.match);
  if (matches.length > LIST_MAX) return overview(matches);
  return grouped(hits, matches.length <= CONTEXT_MAX);
}
