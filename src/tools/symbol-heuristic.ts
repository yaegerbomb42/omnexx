import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath } from '../security/paths.js';
import { distance, walk } from './did-you-mean.js';
import { extractSymbols, type Symbol } from './outline.js';
import { SKIP_DIRS } from './search.js';
import {
  MAX_REFS,
  MAX_TYPES,
  REF_CHARS,
  type SourceBlock,
  type SymbolQuery,
  type SymbolRef,
  type SymbolResult,
} from './symbol-types.js';

/**
 * read_symbol without a language service: definitions come from the outline rules (TS/JS,
 * Python, Go, Rust), bodies from brace or indent matching, call sites from `name(` on a line.
 * Approximate, but bounded and dependency-free.
 */

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs)$/;
const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_BODY_LINES = 400;
const MAX_SIGNATURE_LINES = 8;
const MAX_SUGGESTIONS = 5;
const TYPE_KINDS = new Set(['class', 'interface', 'type', 'enum', 'item']);
const NOT_CALLS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'typeof',
  'await',
  'new',
  'super',
  'print',
  'len',
  'range',
  'def',
  'fn',
  'func',
]);
const BUILTIN_TYPES = new Set([
  'Promise',
  'Array',
  'ReadonlyArray',
  'Record',
  'Map',
  'Set',
  'Partial',
  'Readonly',
  'Required',
  'Pick',
  'Omit',
  'Error',
  'Date',
  'RegExp',
  'Option',
  'Result',
  'Vec',
  'String',
  'Self',
  'None',
  'List',
  'Dict',
  'Optional',
]);

interface IndexedFile {
  file: string;
  lines: string[];
  symbols: Symbol[];
}

const skipped = (rel: string): boolean => rel.split('/').some((seg) => SKIP_DIRS.has(seg));

async function indexRepo(root: string): Promise<IndexedFile[]> {
  const files = (await walk(root))
    .filter((f) => CODE_FILE.test(f) && !skipped(f) && !isSecretPath(f))
    .slice(0, MAX_FILES);
  const read = await Promise.all(
    files.map(async (file) => {
      const abs = join(root, file);
      const size = await stat(abs).then(
        (s) => s.size,
        () => Infinity,
      );
      if (size > MAX_FILE_BYTES) return undefined;
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      return text === undefined
        ? undefined
        : { file, lines: text.split('\n'), symbols: extractSymbols(text) };
    }),
  );
  return read.filter((f): f is IndexedFile => f !== undefined);
}

const indentOf = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;
/** A line without string literals and trailing comments, for brace counting. */
const code = (line: string): string =>
  line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/(?:\/\/|#).*$/, '');

function indentEnd(lines: readonly string[], start: number): number {
  const base = indentOf(lines[start] ?? '');
  let end = start;
  for (let i = start + 1; i < lines.length && i - start < MAX_BODY_LINES; i++) {
    const l = lines[i] ?? '';
    if (!l.trim()) continue;
    if (indentOf(l) <= base) break;
    end = i;
  }
  return end;
}

function braceEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  let opened = false;
  const last = Math.min(lines.length, start + MAX_BODY_LINES) - 1;
  for (let i = start; i <= last; i++) {
    const l = code(lines[i] ?? '');
    for (const ch of l) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && l.trimEnd().endsWith(';')) return i;
  }
  return last;
}

function blockAt(f: IndexedFile, line: number): SourceBlock {
  const start = line - 1;
  const end = f.file.endsWith('.py') ? indentEnd(f.lines, start) : braceEnd(f.lines, start);
  return { file: f.file, start: line, end: end + 1, lines: f.lines.slice(start, end + 1) };
}

const refOf = (f: IndexedFile, line: number): SymbolRef => ({
  file: f.file,
  line,
  text: (f.lines[line - 1] ?? '').trim().slice(0, REF_CHARS),
});

function inPath(file: string, path: string | undefined): boolean {
  if (!path) return true;
  const p = path.replace(/^\.\//, '').replace(/\/$/, '');
  return file === p || file.startsWith(`${p}/`);
}

function definitions(files: readonly IndexedFile[], name: string, kinds?: Set<string>) {
  return files.flatMap((f) =>
    f.symbols
      .filter((s) => s.name === name && (!kinds || kinds.has(s.kind)))
      .map((s) => ({ f, s })),
  );
}

function signatureOf(def: SourceBlock): string {
  const end = def.lines.findIndex((l) => l.includes('{') || /:\s*$/.test(l));
  return def.lines.slice(0, end < 0 ? MAX_SIGNATURE_LINES : end + 1).join('\n');
}

function signatureTypes(files: readonly IndexedFile[], def: SourceBlock, self: string) {
  const names = new Set(signatureOf(def).match(/\b[A-Z]\w*\b/g) ?? []);
  const out: SourceBlock[] = [];
  for (const name of names) {
    if (name === self || BUILTIN_TYPES.has(name)) continue;
    const hit = definitions(files, name, TYPE_KINDS)[0];
    if (hit) out.push(blockAt(hit.f, hit.s.line));
    if (out.length >= MAX_TYPES) break;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function callers(files: readonly IndexedFile[], def: SourceBlock, name: string): SymbolRef[] {
  const call = new RegExp(`\\b${escapeRe(name)}\\s*\\(`);
  const out = new Map<string, SymbolRef>();
  for (const f of files) {
    const defLines = new Set(f.symbols.map((s) => s.line));
    f.lines.forEach((l, i) => {
      const n = i + 1;
      if (!call.test(l) || defLines.has(n)) return;
      if (f.file === def.file && n >= def.start && n <= def.end) return;
      const enclosing = f.symbols.filter((s) => s.line <= n).at(-1);
      const r = refOf(f, enclosing?.line ?? n);
      out.set(`${r.file}:${String(r.line)}`, r);
    });
  }
  return [...out.values()];
}

function callees(files: readonly IndexedFile[], def: SourceBlock, name: string): SymbolRef[] {
  const out = new Map<string, SymbolRef>();
  for (const l of def.lines.slice(1)) {
    for (const m of code(l).matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const callee = m[1] ?? '';
      if (callee === name || NOT_CALLS.has(callee) || out.has(callee)) continue;
      const hit = definitions(files, callee)[0];
      if (hit) out.set(callee, refOf(hit.f, hit.s.line));
    }
  }
  return [...out.values()];
}

/** Up to five symbol names in the repo close to `name`. */
function suggestions(files: readonly IndexedFile[], name: string): string[] {
  const want = name.toLowerCase();
  const limit = Math.max(2, Math.floor(name.length / 3));
  const names = new Set(files.flatMap((f) => f.symbols.map((s) => s.name)));
  return [...names]
    .map((n) => {
      const have = n.toLowerCase();
      const near = have.includes(want) ? 1 : distance(want, have);
      return { n, d: near };
    })
    .filter(({ d }) => d <= limit)
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ n }) => n);
}

export async function readSymbolHeuristic(root: string, q: SymbolQuery): Promise<SymbolResult> {
  const files = await indexRepo(root);
  const found = definitions(files, q.symbol).filter(({ f }) => inPath(f.file, q.path));
  if (!found.length) return { kind: 'missing', suggestions: suggestions(files, q.symbol) };
  const first = found[0];
  if (found.length > 1 || !first) {
    return { kind: 'ambiguous', candidates: found.map(({ f, s }) => refOf(f, s.line)) };
  }
  const def = blockAt(first.f, first.s.line);
  const up = q.depth ? callers(files, def, q.symbol) : [];
  const down = q.depth ? callees(files, def, q.symbol) : [];
  return {
    kind: 'found',
    engine: 'heuristic',
    def,
    types: signatureTypes(files, def, q.symbol),
    callers: up.slice(0, MAX_REFS),
    callees: down.slice(0, MAX_REFS),
    callerTotal: up.length,
    calleeTotal: down.length,
  };
}
