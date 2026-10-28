import { contextTokens, pruneSuperseded as base } from '../../src/agent/compaction.js';
import { corpus } from './corpus.js';
import type { Message } from '../../src/providers/types.js';
type Fn = (m: readonly Message[]) => { messages: Message[] };
export function score(fn: Fn) {
  const out: Record<string, { tokens: number; raw: number; dropped: string[] }> = {};
  for (const c of corpus) {
    const r = fn(c.messages).messages;
    const text = JSON.stringify(r);
    const ids = (ms: Message[]) => ms.flatMap((m) => m.content.map((b) => b.type));
    const paired = JSON.stringify(ids(r)) === JSON.stringify(ids(c.messages));
    out[c.name] = { tokens: contextTokens(r), raw: contextTokens(c.messages),
      dropped: [...c.mustKeep.filter((f) => !text.includes(f)), ...(paired ? [] : ['STRUCTURE'])] };
  }
  const agg = (s: string) => { const cs = corpus.filter((c) => c.split === s);
    return { tokens: cs.reduce((a, c) => a + out[c.name]!.tokens, 0), raw: cs.reduce((a, c) => a + out[c.name]!.raw, 0),
      dropped: cs.flatMap((c) => out[c.name]!.dropped.map((d) => `${c.name}:${d}`)) }; };
  return { train: agg('train'), holdout: agg('holdout'), perCase: out };
}
if (process.argv[1]?.endsWith('score.ts')) console.log(JSON.stringify(score(base), null, 1));
