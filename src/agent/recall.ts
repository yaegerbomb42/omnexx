import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextOr } from '../core/atomic.js';
import type { RunStore } from '../core/run-store.js';

/** One searchable piece of the run's history. */
export interface RecallDoc {
  source: string;
  text: string;
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];

/** Okapi BM25 over small in-memory corpora. Built per call: run history is at most a few MB. */
export function bm25(
  docs: readonly RecallDoc[],
  query: string,
  limit: number,
): { doc: RecallDoc; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !docs.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  const toks = docs.map((d) => tokenize(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  return toks
    .map((t, i) => {
      const tf = new Map<string, number>();
      for (const term of t) tf.set(term, (tf.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of terms) {
        const f = tf.get(term) ?? 0;
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
      }
      return { doc: docs[i] as RecallDoc, score };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/** Split text into ~`size`-char chunks on line boundaries. */
function chunks(text: string, size = 1_500): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > size && cur) {
      out.push(cur);
      cur = '';
    }
    cur += `${line}\n`;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const MAX_LOG_CHARS = 200_000;

/**
 * Everything the run has written down: every progress entry (the context only carries the
 * tail), each task's evidence, lessons, and command and gate logs, chunked.
 */
export async function runHistory(store: RunStore): Promise<RecallDoc[]> {
  const docs: RecallDoc[] = [];
  const progress = await readTextOr(store.file('progress.md'), '');
  for (const e of progress.split(/^(?=## Cycle \d+\n)/m).filter((x) => x.startsWith('## Cycle')))
    docs.push({ source: `progress.md ${e.slice(3, e.indexOf('\n'))}`, text: e });
  const plan = await store.readPlan().catch(() => undefined);
  for (const n of plan?.nodes ?? [])
    for (const ev of n.evidence) docs.push({ source: `evidence ${n.id}`, text: ev });
  const notes = await readTextOr(store.file('notes.md'), '');
  if (notes.trim()) docs.push({ source: 'notes.md', text: notes });
  const logs = await readdir(store.logsDir).catch(() => [] as string[]);
  for (const f of logs.sort()) {
    const text = (await readTextOr(join(store.logsDir, f), '')).slice(-MAX_LOG_CHARS);
    for (const [i, c] of chunks(text).entries())
      docs.push({ source: `logs/${f}${i ? ` #${i + 1}` : ''}`, text: c });
  }
  return docs;
}
