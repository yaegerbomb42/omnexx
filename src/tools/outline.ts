import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { readTextOr } from '../core/atomic.js';
import { isSecretPath } from '../security/paths.js';
import { openError } from './did-you-mean.js';
import { SKIP_DIRS } from './search.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from './types.js';

export interface Symbol {
  line: number;
  endLine?: number;
  kind: string;
  name: string;
  signature?: string;
}

const RULES: readonly [RegExp, string][] = [
  [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'],
  [
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=>/,
    'function',
  ],
  [/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*export\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const'],
  [
    /^\s*(?:public |private |protected |static |async |readonly )*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/,
    'method',
  ],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'],
  [/^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, 'class'],
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'],
  [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type'],
  [/^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/, 'item'],
];
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'constructor',
]);

/** Finds the line where balanced curly braces close after a declaration. */
export function findBraceEndLine(lines: readonly string[], startLine: number): number {
  let depth = 0;
  let seenBrace = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        seenBrace = true;
      } else if (ch === '}') {
        depth--;
        if (seenBrace && depth <= 0) return i + 1;
      }
    }
  }
  return startLine;
}

/** Finds the end line of an indentation-delimited block (e.g. Python def/class). */
export function findPythonEndLine(lines: readonly string[], startLine: number): number {
  const defLine = lines[startLine - 1] ?? '';
  const match = /^\s*/.exec(defLine);
  const baseIndent = match ? match[0].length : 0;
  let lastNonEmpty = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    lastNonEmpty = i + 1;
  }
  return lastNonEmpty;
}

/** Deterministic, dependency-free symbol extraction with line boundary tracking. */
export function extractSymbols(text: string): Symbol[] {
  const out: Symbol[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [re, kind] of RULES) {
      const m = re.exec(line);
      const name = m?.[1];
      if (name && !KEYWORDS.has(name)) {
        const startLine = i + 1;
        let endLine: number | undefined;
        if (kind === 'def' || (kind === 'class' && !line.includes('{'))) {
          const calculatedEnd = findPythonEndLine(lines, startLine);
          if (calculatedEnd > startLine) endLine = calculatedEnd;
        } else if (
          kind === 'function' ||
          kind === 'class' ||
          kind === 'interface' ||
          kind === 'method' ||
          kind === 'enum' ||
          kind === 'item' ||
          kind === 'func'
        ) {
          const calculatedEnd = findBraceEndLine(lines, startLine);
          if (calculatedEnd > startLine) endLine = calculatedEnd;
        }
        out.push({
          line: startLine,
          ...(endLine !== undefined ? { endLine } : {}),
          kind,
          name,
        });
        break;
      }
    }
  });
  return out;
}

export function renderOutline(symbols: readonly Symbol[], totalLines: number): string {
  if (!symbols.length) return `(no symbols found; ${totalLines} lines)`;
  return [
    `${totalLines} lines`,
    ...symbols.map((s) => {
      const range = s.endLine && s.endLine > s.line ? ` (lines ${s.line}-${s.endLine})` : '';
      return `${String(s.line).padStart(5)}  ${s.kind} ${s.name}${range}`;
    }),
  ].join('\n');
}

/** Files one outline call may take through `paths`. */
export const MAX_OUTLINE_FILES = 20;
/** Files a directory outline returns. The rest are a one-line remainder, not a dump. */
export const MAX_DIR_FILES = 80;
/** Top symbols per file in a directory outline. Matches the codebase map's own cap. */
export const MAX_DIR_SYMBOLS = 8;
const MAX_FILE_BYTES = 1_000_000;
const WALK_MAX_DEPTH = 8;

const SOURCE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|sh)$/i;

const schema = z.strictObject({
  path: z
    .string()
    .optional()
    .describe('File or directory; a directory returns its codebase-map slice'),
  paths: z
    .array(z.string())
    .min(1)
    .max(MAX_OUTLINE_FILES)
    .optional()
    .describe(`Several files in one call (up to ${MAX_OUTLINE_FILES})`),
});

interface SliceEntry {
  path: string;
  lines: number;
  symbols: string[];
  purpose?: string;
}

const storedSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      lines: z.number(),
      symbols: z.array(z.string()).optional(),
      purpose: z.string().optional(),
    }),
  ),
});

function normalizeDir(path: string): string {
  const n = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return n === '.' ? '' : n;
}

function underDir(file: string, dir: string): boolean {
  if (!dir) return true;
  return file === dir || file.startsWith(`${dir}/`);
}

function formatEntry(e: SliceEntry): string {
  const symbols = e.symbols.slice(0, MAX_DIR_SYMBOLS);
  const sym = symbols.length ? `: ${symbols.join(', ')}` : '';
  const purpose = e.purpose ? ` — ${e.purpose}` : '';
  return `${e.path} (${e.lines})${purpose}${sym}`;
}

function renderDirSlice(dir: string, entries: readonly SliceEntry[], truncated: boolean): string {
  const label = dir || '.';
  if (!entries.length) return `(no files under ${label})`;
  const head = truncated
    ? `${label} (${entries.length} files shown; outline a subdirectory for the rest)`
    : `${label} (${entries.length} files)`;
  return [head, ...entries.map(formatEntry)].join('\n');
}

/** The stored codebase map, or undefined when this run has not built one. Never rebuilds it. */
async function storedEntries(ctx: ToolContext): Promise<SliceEntry[] | undefined> {
  const text = await readTextOr(ctx.store.file('codemap.json'), '');
  if (!text) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const parsed = storedSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data.entries.map((e) => ({
    path: e.path,
    lines: e.lines,
    symbols: e.symbols ?? [],
    ...(e.purpose ? { purpose: e.purpose } : {}),
  }));
}

async function entryFromFile(abs: string, rel: string): Promise<SliceEntry | undefined> {
  const info = await stat(abs).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined || text.includes('\0')) return undefined;
  const symbols = SOURCE.test(rel)
    ? extractSymbols(text)
        .slice(0, MAX_DIR_SYMBOLS)
        .map((s) => `${s.kind} ${s.name}`)
    : [];
  return { path: rel, lines: text.split('\n').length, symbols };
}

/**
 * One directory only, when no codebase map is stored (chat, or a run before the map exists).
 * Stops after `MAX_DIR_FILES` files so a huge tree cannot fill the tool result.
 */
async function diskSlice(
  root: string,
  absDir: string,
): Promise<{ entries: SliceEntry[]; truncated: boolean }> {
  const found: string[] = [];
  let truncated = false;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_DIR_FILES) {
      truncated = true;
      return;
    }
    if (depth > WALK_MAX_DEPTH) {
      truncated = true;
      return;
    }
    const listed = await readdir(dir, { withFileTypes: true }).catch(() => []);
    listed.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of listed) {
      if (found.length >= MAX_DIR_FILES) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (rel.startsWith('..') || isSecretPath(rel)) continue;
      if (e.isDirectory()) await visit(abs, depth + 1);
      else if (e.isFile()) found.push(abs);
    }
  };
  await visit(absDir, 1);
  const entries: SliceEntry[] = [];
  for (const abs of found) {
    const rel = relative(root, abs).split(sep).join('/');
    const entry = await entryFromFile(abs, rel);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated };
}

async function outlineDirectory(
  dirRel: string,
  abs: string,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const stored = await storedEntries(ctx);
  if (stored) {
    const entries = stored
      .filter((e) => underDir(e.path, dirRel))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const shown = entries.slice(0, MAX_DIR_FILES);
    return ok(renderDirSlice(dirRel, shown, entries.length > shown.length));
  }
  const disk = await diskSlice(ctx.jail.root, abs);
  return ok(renderDirSlice(dirRel, disk.entries, disk.truncated));
}

async function outlineOne(path: string, ctx: ToolContext): Promise<ToolOutput> {
  try {
    const text = await readFile(ctx.jail.resolve(path, 'read'), 'utf8');
    return ok(renderOutline(extractSymbols(text), text.split('\n').length));
  } catch (err) {
    return fail(await openError(ctx, path, err, '', 'outline'));
  }
}

/** A directory path is the map slice; a file path is today's symbol outline. `paths` stays files. */
async function outlineTarget(path: string, ctx: ToolContext): Promise<ToolOutput> {
  let abs: string;
  try {
    abs = ctx.jail.resolve(path, 'read');
  } catch (err) {
    return fail(await openError(ctx, path, err, '', 'outline'));
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch (err) {
    return fail(await openError(ctx, path, err, '', 'outline'));
  }
  if (info.isDirectory()) return outlineDirectory(normalizeDir(ctx.jail.relative(abs)), abs, ctx);
  if (info.isFile()) return outlineOne(path, ctx);
  return fail(`cannot outline ${path}: not a file or directory`);
}

export const outlineTool: Tool<typeof schema> = {
  name: 'outline',
  description:
    "A file's symbols with line numbers, or a directory's codebase-map slice. Use before reading large files.",
  schema,
  readOnly: true,
  concurrent: true,
  async run(input, ctx) {
    if (input.paths && input.path !== undefined)
      return fail('outline takes either path or paths: [...], not both');
    if (!input.paths) {
      if (input.path === undefined) return fail('outline needs path, or paths: [...]');
      return outlineTarget(input.path, ctx);
    }
    const outs = await Promise.all(input.paths.map((p) => outlineOne(p, ctx)));
    const content = input.paths.map((p, i) => `== ${p} ==\n${outs[i]?.content ?? ''}`).join('\n\n');
    return outs.every((o) => o.isError) ? fail(content) : ok(content);
  },
};
