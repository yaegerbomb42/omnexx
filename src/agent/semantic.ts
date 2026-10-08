import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { trackedFiles } from './codemap.js';
import { readTextOr, writeJsonAtomic } from '../core/atomic.js';
import type { OmnexxPaths } from '../core/paths.js';
import { repoMemoryFile } from '../core/repo-memory.js';
import { ProviderError } from '../errors.js';
import { isSecretPath } from '../security/paths.js';

export interface EmbeddingEndpoint {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  fetch?: typeof fetch;
}

const BATCH = 64;
const MAX_FILE_BYTES = 200_000;
const CODE =
  /\.(m?[jt]sx?|c[jt]s|py|go|rs|java|kt|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|sh|sql|vue|svelte|lua|dart|ex|exs|md|toml|ya?ml|json)$/i;

/** One OpenAI-compatible /embeddings call per batch of up to 64 texts. */
export async function embed(ep: EmbeddingEndpoint, texts: readonly string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await (ep.fetch ?? fetch)(`${ep.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: ep.model, input: texts.slice(i, i + BATCH) }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { embedding?: number[]; index?: number }[];
      error?: { message?: string };
      message?: string;
    };
    if (!res.ok || !body.data)
      throw new ProviderError(
        `embeddings failed (HTTP ${res.status}): ${body.error?.message ?? body.message ?? 'no data'}`,
        { retryable: res.status >= 500 || res.status === 429, status: res.status },
      );
    const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const d of sorted) out.push(d.embedding ?? []);
  }
  return out;
}

interface Chunk {
  start: number;
  end: number;
  /** Float32 vector, base64 (compact on disk). */
  v: string;
}
interface IndexFile {
  model: string;
  files: Record<string, { hash: string; chunks: Chunk[] }>;
}

const toB64 = (v: readonly number[]): string =>
  Buffer.from(new Float32Array(v).buffer).toString('base64');
const fromB64 = (s: string): Float32Array => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Overlapping windows of `size` lines (a quarter overlap), as [start, end] 1-based inclusive. */
export function chunkLines(lineCount: number, size: number): [number, number][] {
  const step = Math.max(1, Math.floor((size * 3) / 4));
  const out: [number, number][] = [];
  for (let s = 0; s < lineCount; s += step) {
    out.push([s + 1, Math.min(lineCount, s + size)]);
    if (s + size >= lineCount) break;
  }
  return out;
}

export interface SearchHit {
  path: string;
  start: number;
  end: number;
  score: number;
  text: string;
}

/**
 * A per-repo semantic index of the codebase, kept next to the repo's memory and refreshed
 * incrementally: only files whose content changed are embedded again.
 */
export class SemanticIndex {
  private constructor(
    private readonly root: string,
    private readonly file: string,
    private readonly ep: EmbeddingEndpoint,
    private readonly opts: { maxFiles: number; chunkLines: number },
  ) {}

  static async open(
    paths: OmnexxPaths,
    root: string,
    ep: EmbeddingEndpoint,
    opts: { maxFiles: number; chunkLines: number },
  ): Promise<SemanticIndex> {
    const file = join(dirname(await repoMemoryFile(paths, root)), 'semantic.json');
    return new SemanticIndex(root, file, ep, opts);
  }

  /** Bring the index up to date; returns how many files were (re)embedded. */
  async refresh(): Promise<{ embedded: number; files: number }> {
    const raw = await readTextOr(this.file, '');
    let idx: IndexFile = raw ? (JSON.parse(raw) as IndexFile) : { model: this.ep.model, files: {} };
    if (idx.model !== this.ep.model) idx = { model: this.ep.model, files: {} };
    const paths = (await trackedFiles(this.root))
      .filter((p) => CODE.test(p) && !isSecretPath(p))
      .slice(0, this.opts.maxFiles);
    const keep: IndexFile['files'] = {};
    const todo: { path: string; hash: string; lines: string[] }[] = [];
    for (const p of paths) {
      const text = await readFile(join(this.root, p), 'utf8').catch(() => undefined);
      if (text === undefined || text.length > MAX_FILE_BYTES || text.includes('\0')) continue;
      const hash = createHash('sha1').update(text).digest('hex');
      const known = idx.files[p];
      if (known?.hash === hash) keep[p] = known;
      else todo.push({ path: p, hash, lines: text.split('\n') });
    }
    const pieces = todo.flatMap((f) =>
      chunkLines(f.lines.length, this.opts.chunkLines).map(([s, e]) => ({
        f,
        s,
        e,
        text: `${f.path}:${s}-${e}\n${f.lines.slice(s - 1, e).join('\n')}`.slice(0, 8_000),
      })),
    );
    const vecs = pieces.length
      ? await embed(
          this.ep,
          pieces.map((p) => p.text),
        )
      : [];
    for (const [i, p] of pieces.entries()) {
      const entry = (keep[p.f.path] ??= { hash: p.f.hash, chunks: [] });
      entry.chunks.push({ start: p.s, end: p.e, v: toB64(vecs[i] ?? []) });
    }
    await writeJsonAtomic(this.file, { model: this.ep.model, files: keep });
    return { embedded: todo.length, files: Object.keys(keep).length };
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const raw = await readTextOr(this.file, '');
    if (!raw) return [];
    const idx = JSON.parse(raw) as IndexFile;
    const [qv] = await embed(this.ep, [query]);
    if (!qv) return [];
    const q = new Float32Array(qv);
    const scored: Omit<SearchHit, 'text'>[] = [];
    for (const [path, f] of Object.entries(idx.files))
      for (const c of f.chunks)
        scored.push({ path, start: c.start, end: c.end, score: cosine(q, fromB64(c.v)) });
    scored.sort((a, b) => b.score - a.score);
    const hits: SearchHit[] = [];
    for (const h of scored.slice(0, limit)) {
      const lines = (await readFile(join(this.root, h.path), 'utf8').catch(() => '')).split('\n');
      hits.push({ ...h, text: lines.slice(h.start - 1, h.end).join('\n') });
    }
    return hits;
  }
}
