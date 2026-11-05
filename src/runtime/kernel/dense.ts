/**
 * Dense (embedding) side of hybrid capability retrieval, backed by local Ollama
 * (`nomic-embed-text` by default, zero API cost).
 *
 * Two modes, both optional and failure-tolerant (Ollama down → BM25 only):
 * - rerank: embed only the BM25 candidates (cached per id) and fuse scores
 * - full:   embed the whole catalog once in the background (cached on disk), so dense
 *           search can contribute candidates BM25 never saw ("rain tomorrow" → weather)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface DenseDoc {
  id: string;
  text: string;
}

export interface DenseIndexOptions {
  ollamaUrl?: string | undefined;
  model?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** gzip cache of id → vector (persisted across runs). */
  cachePath?: string | undefined;
  batchSize?: number | undefined;
  /** Per-request timeout (ms). */
  timeoutMs?: number | undefined;
}

export function denseDocText(e: {
  name: string;
  description: string;
  server?: string | undefined;
}): string {
  const tail = (e.server ?? e.name).split('/').pop() ?? e.name;
  return `${e.name} (${tail}): ${e.description}`.slice(0, 512);
}

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) * inv;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

export class DenseIndex {
  private readonly vectors = new Map<string, Float32Array>();
  private readonly url: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly batch: number;
  private readonly timeoutMs: number;
  private down = false;
  private dirty = false;

  constructor(private readonly opts: DenseIndexOptions = {}) {
    this.url = (opts.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'nomic-embed-text';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.batch = opts.batchSize ?? 64;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get size(): number {
    return this.vectors.size;
  }

  get available(): boolean {
    return !this.down;
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  get(id: string): Float32Array | undefined {
    return this.vectors.get(id);
  }

  private async embed(texts: string[]): Promise<Float32Array[] | undefined> {
    if (this.down || texts.length === 0) return texts.length ? undefined : [];
    try {
      const res = await this.fetchImpl(`${this.url}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts, keep_alive: -1 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`ollama embed HTTP ${res.status}`);
      const body = (await res.json()) as { embeddings?: number[][] };
      if (body.embeddings?.length !== texts.length) throw new Error('bad embed reply');
      return body.embeddings.map(normalize);
    } catch {
      this.down = true; // fail closed to BM25-only for the rest of the session
      return undefined;
    }
  }

  async embedQuery(query: string): Promise<Float32Array | undefined> {
    const r = await this.embed([`search_query: ${query}`]);
    return r?.[0];
  }

  /** Embed any docs not yet cached. Returns how many were added. */
  async ensure(docs: readonly DenseDoc[], signal?: AbortSignal): Promise<number> {
    const missing = docs.filter((d) => !this.vectors.has(d.id));
    let added = 0;
    for (let i = 0; i < missing.length; i += this.batch) {
      if (signal?.aborted || this.down) break;
      const chunk = missing.slice(i, i + this.batch);
      const vecs = await this.embed(chunk.map((d) => `search_document: ${d.text}`));
      if (!vecs) break;
      chunk.forEach((d, j) => this.vectors.set(d.id, vecs[j] as Float32Array));
      added += chunk.length;
      this.dirty = true;
    }
    return added;
  }

  /** Brute-force cosine top-k over every cached vector (~30ms per 50k on one core). */
  search(q: Float32Array, k: number): { id: string; score: number }[] {
    const top: { id: string; score: number }[] = [];
    let floor = -Infinity;
    for (const [id, v] of this.vectors) {
      const s = dot(q, v);
      if (top.length < k || s > floor) {
        top.push({ id, score: s });
        if (top.length > k) {
          top.sort((a, b) => b.score - a.score);
          top.length = k;
        }
        floor = top.length >= k ? Math.min(...top.map((t) => t.score)) : -Infinity;
      }
    }
    return top.sort((a, b) => b.score - a.score);
  }

  async load(): Promise<number> {
    if (!this.opts.cachePath) return 0;
    try {
      const raw = JSON.parse(gunzipSync(await readFile(this.opts.cachePath)).toString('utf8')) as {
        model: string;
        vectors: Record<string, string>;
      };
      if (raw.model !== this.model) return 0;
      // int8-quantized unit vectors (4x smaller than float32; cosine error < 1%).
      for (const [id, b64] of Object.entries(raw.vectors)) {
        const q = new Int8Array(Buffer.from(b64, 'base64'));
        const v = new Float32Array(q.length);
        for (let i = 0; i < q.length; i++) v[i] = (q[i] as number) / 127;
        this.vectors.set(id, normalize(Array.from(v)));
      }
      return this.vectors.size;
    } catch {
      return 0;
    }
  }

  async save(): Promise<void> {
    if (!this.opts.cachePath || !this.dirty) return;
    const vectors: Record<string, string> = {};
    for (const [id, v] of this.vectors) {
      const q = new Int8Array(v.length);
      for (let i = 0; i < v.length; i++)
        q[i] = Math.max(-127, Math.min(127, Math.round((v[i] as number) * 127)));
      vectors[id] = Buffer.from(q.buffer).toString('base64');
    }
    await mkdir(dirname(this.opts.cachePath), { recursive: true });
    await writeFile(this.opts.cachePath, gzipSync(JSON.stringify({ model: this.model, vectors })));
    this.dirty = false;
  }
}
