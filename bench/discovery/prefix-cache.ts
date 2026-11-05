/**
 * Anthropic-style prefix cache simulator shared by the cache and optimizer benches: the wire
 * request (tools -> system -> messages) is linearized into blocks with chained hashes; any
 * previously written breakpoint prefix is a cache read, the span up to the last breakpoint
 * is a write (1.25x), the rest is uncached (1x); reads bill 0.1x.
 */
import { createHash } from 'node:crypto';
import type { AnthropicProvider } from '../../src/providers/anthropic.js';
import { estimateTokens } from '../../src/runtime/kernel/cache-epoch.js';

export interface TurnBill {
  total: number;
  read: number;
  write: number;
  uncached: number;
  billed: number;
}

export class PrefixCache {
  private readonly store = new Set<string>();
  bill(params: ReturnType<AnthropicProvider['buildParams']>): TurnBill {
    const blocks: { v: unknown; bp: boolean }[] = [
      ...(params.tools ?? []).map((x) => ({ v: x, bp: 'cache_control' in x })),
      ...(params.system as object[]).map((x) => ({ v: x, bp: 'cache_control' in x })),
      ...params.messages.flatMap((m) =>
        (m.content as object[]).map((c) => ({ v: { r: m.role, c }, bp: 'cache_control' in c })),
      ),
    ];
    let h = '';
    let pos = 0;
    let hit = 0;
    let lastBp = 0;
    const bps: string[] = [];
    for (const b of blocks) {
      const clean = JSON.stringify(b.v, (k, x: unknown) => (k === 'cache_control' ? undefined : x));
      h = createHash('sha1')
        .update(h + clean)
        .digest('hex');
      pos += estimateTokens(clean);
      if (this.store.has(h)) hit = pos;
      if (b.bp) {
        lastBp = pos;
        bps.push(h);
      }
    }
    for (const x of bps) this.store.add(x);
    const write = Math.max(0, lastBp - hit);
    const uncached = pos - hit - write;
    return { total: pos, read: hit, write, uncached, billed: hit * 0.1 + write * 1.25 + uncached };
  }
}
