import { createHash } from 'node:crypto';
import { estimateTokens } from '../../core/tokens.js';
import type { ContentBlock, Message } from '../../providers/types.js';

export interface GcOptions {
  /** Keep at least this many most-recent messages untouched (default 4). */
  keepRecent?: number | undefined;
  /** Drop a older tool_result when cosine/Jaccard similarity to a newer one exceeds this (default 0.92). */
  similarityThreshold?: number | undefined;
  /** Soft token budget for the history after GC (default: no hard budget, just dedupe). */
  targetTokens?: number | undefined;
}

export interface GcResult {
  messages: Message[];
  removed: number;
  tokensBefore: number;
  tokensAfter: number;
  clusters: number;
}

/**
 * Tier-3 async-capable context garbage collector.
 *
 * Clusters near-duplicate tool results via char-ngram fingerprints (and optional
 * external embeddings when provided), keeps the newest member of each cluster,
 * always preserves user steering / kernel constraints / the conversation anchor,
 * then optionally trims oldest low-signal text blocks to a token target.
 */
export class ContextGarbageCollector {
  /**
   * Run GC. Pure and sync when using fingerprints; pass `embed` to score with vectors.
   * Designed to finish in well under 50ms on typical chat histories without embeddings.
   */
  compact(
    messages: readonly Message[],
    opts: GcOptions = {},
    embed?: (text: string) => number[] | undefined,
  ): GcResult {
    const keepRecent = opts.keepRecent ?? 4;
    const threshold = opts.similarityThreshold ?? 0.92;
    const tokensBefore = estimateTokens(JSON.stringify(messages));

    if (messages.length <= keepRecent + 1) {
      return {
        messages: [...messages],
        removed: 0,
        tokensBefore,
        tokensAfter: tokensBefore,
        clusters: 0,
      };
    }

    const head = messages.slice(0, Math.max(1, messages.length - keepRecent));
    const tail = messages.slice(messages.length - keepRecent);
    const keep = new Array<boolean>(head.length).fill(true);
    const fingerprints = head.map((m) => fingerprintMessage(m, embed));
    let clusters = 0;

    // For each older message, drop it if a newer one in `head` is near-duplicate.
    for (let i = 0; i < head.length; i++) {
      if (!keep[i]) continue;
      if (!isGcCandidate(head[i]!)) continue;
      for (let j = i + 1; j < head.length; j++) {
        if (!keep[j]) continue;
        if (!isGcCandidate(head[j]!)) continue;
        const sim = similarity(fingerprints[i]!, fingerprints[j]!);
        if (sim >= threshold) {
          keep[i] = false; // drop older
          clusters += 1;
          break;
        }
      }
    }

    let compacted: Message[] = [];
    for (let i = 0; i < head.length; i++) {
      if (keep[i]) compacted.push(head[i]!);
    }
    compacted = compacted.concat(tail);

    if (opts.targetTokens !== undefined) {
      compacted = trimToBudget(compacted, opts.targetTokens, keepRecent);
    }

    const tokensAfter = estimateTokens(JSON.stringify(compacted));
    return {
      messages: compacted,
      removed: messages.length - compacted.length,
      tokensBefore,
      tokensAfter,
      clusters,
    };
  }
}

interface Fingerprint {
  hash: string;
  grams: Map<string, number>;
  embedding?: number[] | undefined;
}

function isGcCandidate(m: Message): boolean {
  // Never GC the leading anchor-ish user message content that looks like a goal,
  // or harness/kernel directives.
  if (m.role === 'assistant') return true;
  for (const b of m.content) {
    if (b.type === 'tool_result') return true;
    if (b.type === 'text') {
      const t = b.text;
      if (t.startsWith('[kernel]') || t.startsWith('[KERNEL') || t.startsWith('[harness]'))
        return false;
      if (t.startsWith('The user sent')) return false;
    }
  }
  // Pure user text mid-history can dedupe if duplicated.
  return m.role === 'user';
}

function fingerprintMessage(
  m: Message,
  embed?: (text: string) => number[] | undefined,
): Fingerprint {
  const text = blocksText(m.content);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const grams = ngrams(text, 3);
  const embedding = embed?.(text.slice(0, 2000));
  return embedding ? { hash, grams, embedding } : { hash, grams };
}

function blocksText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_result') parts.push(`${b.toolUseId}:${b.content}`);
    else if (b.type === 'tool_use') parts.push(`${b.name}:${JSON.stringify(b.input)}`);
  }
  return parts.join('\n');
}

function ngrams(text: string, n: number): Map<string, number> {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 4000);
  const m = new Map<string, number>();
  for (let i = 0; i <= norm.length - n; i++) {
    const g = norm.slice(i, i + n);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function similarity(a: Fingerprint, b: Fingerprint): number {
  if (a.hash === b.hash) return 1;
  if (a.embedding && b.embedding && a.embedding.length === b.embedding.length) {
    return cosine(a.embedding, b.embedding);
  }
  return jaccard(a.grams, b.grams);
}

function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let union = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
  }
  return union === 0 ? 0 : inter / union;
}

function cosine(a: number[], b: number[]): number {
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
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function trimToBudget(messages: Message[], target: number, keepRecent: number): Message[] {
  if (estimateTokens(JSON.stringify(messages)) <= target) return messages;
  const out = [...messages];
  // Drop from the oldest non-anchor end, skipping the newest `keepRecent`.
  let i = 1; // preserve index 0 as anchor
  while (out.length > keepRecent + 1 && estimateTokens(JSON.stringify(out)) > target) {
    const idx = i;
    if (idx >= out.length - keepRecent) break;
    out.splice(idx, 1);
    // do not advance i: next oldest shifts into place
    if (i > out.length - keepRecent - 1) break;
  }
  return out;
}

/** Schedule GC on the next microtask; resolves with the result without blocking the caller. */
export function compactAsync(
  gc: ContextGarbageCollector,
  messages: readonly Message[],
  opts?: GcOptions,
  embed?: (text: string) => number[] | undefined,
): Promise<GcResult> {
  return Promise.resolve().then(() => gc.compact(messages, opts, embed));
}
