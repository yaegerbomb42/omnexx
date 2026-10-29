import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractSymbols, type Symbol } from '../tools/outline.js';

/**
 * Persistent AST & symbol hashing.
 *
 * The agent re-reads the same files over and over: the codebase map, an outline, a read, a
 * symbol lookup. Every one of those re-reads the file and re-parses it, and every parse is
 * paid for again in tokens. This cache keys a file by the hash of its bytes, so a file that
 * did not change is parsed once and reused: no re-read, no re-tokenization.
 *
 * The cache is content-addressed, never path-addressed: the same bytes at another path are
 * the same entry, and a changed file is a new entry (the old one is dropped). It survives
 * process restarts (a JSON file per repo), so a long session pays the parse cost once.
 */

/** What one file's parse produced: its symbols and the modules it imports. */
export interface FileAst {
  /** SHA-256 of the file's bytes, lowercase hex. The entry's identity. */
  hash: string;
  /** Symbols with their line numbers and kinds. */
  symbols: Symbol[];
  /** Module specifiers the file imports, in source order, deduplicated. */
  imports: string[];
  /** The file's line count. */
  lines: number;
  /** Estimated tokens of the file's text: what re-reading it would cost. */
  tokens: number;
}

/** The on-disk cache: one JSON file, keyed by content hash. */
interface CacheFile {
  version: 1;
  /** Content hash -> the parsed file. */
  entries: Record<string, FileAst>;
  /** Repo-relative path -> the file's last known stat and hash. */
  paths?: Record<string, PathEntry>;
}

/**
 * What the cache remembers about one path: its size and modification time, and the hash of
 * the bytes it had then.
 *
 * The stat is the fast path: when a file's size and mtime are unchanged since the last
 * parse, its bytes are unchanged, so the file is never read again. The hash is the
 * authority: when the stat says "changed", the file is read and hashed, and only then is
 * the entry replaced.
 */
export interface PathEntry {
  /** The file's size in bytes when it was parsed. */
  size: number;
  /** The file's modification time in milliseconds when it was parsed. */
  mtimeMs: number;
  /** The hash of the bytes when it was parsed. */
  hash: string;
}

/** Cache file format version; a different one is discarded, not migrated. */
const CACHE_VERSION = 1;

/** Files above this size are not parsed (a minified bundle has no useful symbols). */
export const MAX_CACHE_FILE_BYTES = 1_000_000;

/** Entries kept in the cache file; the oldest are dropped first (insertion order). */
const MAX_ENTRIES = 5_000;

/** Languages we extract imports from. Others still get symbols. */
const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from 'y' / import 'y' / import type { a } from 'y'
  /^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  // export ... from 'y'
  /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm,
  // require('y')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // from x import y / import x in Python
  /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/gm,
];

/** The imports of a file: module specifiers, deduplicated, in source order. */
export function extractImports(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const spec = m[1] ?? m[2];
      if (!spec || seen.has(spec)) continue;
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/** The content hash of a file's bytes: the cache's key. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parse a file's text into its AST entry: symbols, imports, line count, token estimate. */
export function parseFile(text: string): Omit<FileAst, 'hash'> {
  return {
    symbols: extractSymbols(text),
    imports: extractImports(text),
    lines: text.split('\n').length,
    // 3 chars/token is the harness's own conservative estimate (src/core/tokens.ts).
    tokens: Math.ceil(text.length / 3),
  };
}

/**
 * The cache for one repo. It reads its file once, then keeps it in memory; `flush` writes it
 * back. Entries are dropped when their file changes, so the cache never grows without bound.
 */
export class AstCache {
  private entries = new Map<string, FileAst>();
  private paths = new Map<string, PathEntry>();
  private dirty = false;
  private loaded = false;
  /** Where the cache file lives. */
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Load the cache file once. A missing or broken file starts an empty cache. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const file = parsed as Partial<CacheFile>;
    if (file.version !== CACHE_VERSION || typeof file.entries !== 'object') return;
    // The parsed JSON is untrusted: iterate its values as unknown and validate each one.
    const rawEntries: Record<string, unknown> = file.entries;
    for (const [hash, entry] of Object.entries(rawEntries)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<FileAst>;
      if (typeof e.hash !== 'string' || !Array.isArray(e.symbols)) continue;
      this.entries.set(hash, {
        hash: e.hash,
        symbols: e.symbols,
        imports: Array.isArray(e.imports) ? e.imports : [],
        lines: typeof e.lines === 'number' ? e.lines : 0,
        tokens: typeof e.tokens === 'number' ? e.tokens : 0,
      });
    }
    const rawPaths: Record<string, unknown> = file.paths ?? {};
    for (const [path, entry] of Object.entries(rawPaths)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<PathEntry>;
      if (typeof e.hash !== 'string' || typeof e.size !== 'number') continue;
      this.paths.set(path, {
        size: e.size,
        mtimeMs: typeof e.mtimeMs === 'number' ? e.mtimeMs : 0,
        hash: e.hash,
      });
    }
  }

  /**
   * The entry for a path whose bytes are unchanged since it was last parsed, or undefined.
   *
   * `size` and `mtimeMs` come from a stat: when they match what was recorded, the bytes
   * are the same, so the file is not read again at all. This is the fast path that keeps
   * an unchanged file from being re-read and re-tokenized.
   */
  getByPath(path: string, size: number, mtimeMs: number): FileAst | undefined {
    const known = this.paths.get(path);
    if (known?.size !== size || known.mtimeMs !== mtimeMs) return undefined;
    const entry = this.entries.get(known.hash);
    return entry;
  }

  /** Remember a path's stat and the hash of the bytes it had. */
  setPath(path: string, size: number, mtimeMs: number, hash: string): void {
    const known = this.paths.get(path);
    if (known?.hash === hash && known.size === size && known.mtimeMs === mtimeMs) return;
    this.paths.set(path, { size, mtimeMs, hash });
    this.dirty = true;
  }

  /** Forget a path (the file was deleted). */
  forgetPath(path: string): void {
    if (this.paths.delete(path)) this.dirty = true;
  }

  /** The entry for these bytes, or undefined when the file was never parsed. */
  get(hash: string): FileAst | undefined {
    return this.entries.get(hash);
  }

  /** Store an entry. Replaces an entry with the same hash (the bytes are the same). */
  set(entry: FileAst): void {
    this.entries.delete(entry.hash);
    this.entries.set(entry.hash, entry);
    this.dirty = true;
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** How many files are cached. */
  get size(): number {
    return this.entries.size;
  }

  /** Total estimated tokens of the cached files: what re-reading them would cost. */
  get tokens(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.tokens;
    return sum;
  }

  /** Write the cache back to disk. A no-op when nothing changed. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const file: CacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries),
      paths: Object.fromEntries(this.paths),
    };
    await mkdir(dirname(this.file), { recursive: true });
    // Written to a unique temp file and renamed, so concurrent flushes never clobber each other
    // and a crash never leaves a half-written cache.
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    this.dirty = false;
  }

  /** Forget everything (the cache file is rewritten on the next flush). */
  clear(): void {
    this.entries.clear();
    this.paths.clear();
    this.dirty = true;
  }
}

/** Where a repo's AST cache lives: beside the run's other state. */
export function astCacheFile(cacheDir: string, repoRoot: string): string {
  return join(cacheDir, `ast-${hashContent(repoRoot).slice(0, 16)}.json`);
}

/**
 * The AST of a file, from the cache when the bytes are unchanged and from a fresh parse
 * otherwise. `text` is the file's content (the caller reads it once); the returned entry
 * says whether it came from the cache.
 */
export function astFor(cache: AstCache, text: string): { ast: FileAst; hit: boolean } {
  const hash = hashContent(text);
  const hit = cache.get(hash);
  if (hit) return { ast: hit, hit: true };
  const ast: FileAst = { hash, ...parseFile(text) };
  cache.set(ast);
  return { ast, hit: false };
}

/** Whether a file is worth parsing at all (too big, or not source). */
export function isCacheableSource(path: string, size: number): boolean {
  if (size > MAX_CACHE_FILE_BYTES) return false;
  return /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|sh)$/i.test(path);
}

/**
 * The AST of a file on disk, from the cache when the file has not changed.
 *
 * The fast path never reads the file: a stat says the size and mtime are the same as when
 * it was last parsed, so its bytes are the same and the cached AST is used as is. Only a
 * file that changed is read and re-parsed.
 *
 * `rel` is the repo-relative path (the cache's key for the path), `abs` the file's location.
 */
export async function astForFile(
  cache: AstCache,
  rel: string,
  abs: string,
): Promise<{ ast: FileAst; hit: boolean; read: boolean } | undefined> {
  let info: Stats;
  try {
    info = await stat(abs);
  } catch {
    cache.forgetPath(rel);
    return undefined;
  }
  if (!info.isFile()) return undefined;
  const cached = cache.getByPath(rel, info.size, info.mtimeMs);
  if (cached) return { ast: cached, hit: true, read: false };
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
  const { ast, hit } = astFor(cache, text);
  cache.setPath(rel, info.size, info.mtimeMs, ast.hash);
  return { ast, hit, read: true };
}
