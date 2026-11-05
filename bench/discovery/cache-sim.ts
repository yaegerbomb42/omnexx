/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-deprecated */
/**
 * 4-policy prompt-cache benchmark: replays one 40-turn kernel chat (MCP capabilities mounted
 * and unmounted mid-chat, tier>=2 hints, three GC opportunities (one 3 turns before the end)) through the real turnRequest +
 * AnthropicProvider.buildParams wire format and an Anthropic-style prefix cache, and reports
 * billed cost (uncached 1x, cache read 0.1x, cache write 1.25x) and prefix-cache hit %.
 *
 *   npx -y tsx bench/discovery/cache-sim.ts
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { turnRequest } from '../../src/agent/context.js';
import { withKernelHint } from '../../src/agent/loop.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import type { Message, SystemBlock, ToolSpec } from '../../src/providers/types.js';
import {
  ToolEpoch,
  capabilityDirective,
  estimateTokens,
  foldPaysOff,
} from '../../src/runtime/kernel/cache-epoch.js';
import { toolSpec } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/types.js';

const TURNS = 40;
const pad = (n: number, seed: string) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1)));
const mk = (name: string): Tool =>
  ({
    name,
    description: `${name}: ${pad(300, 'does a thing with args')}`,
    schema: z.object({ a: z.string(), b: z.number().optional(), c: z.boolean().optional() }),
    readOnly: true,
    run: async () => ({ content: 'ok' }),
  }) as unknown as Tool;
const core = ['read', 'edit', 'bash', 'search', 'write', 'manage_capabilities'].map(mk);
const server = (s: string) => [1, 2, 3, 4, 5].map((i) => mk(`mcp__${s}__op${String(i)}`));
/** Mounted MCP servers per turn (the kernel's select step churns ~1 swap / few turns). */
function mountedAt(turn: number): Tool[] {
  const s: string[] = [];
  if (turn >= 5) s.push('github');
  if (turn >= 12 && turn < 26) s.push('postgres');
  if (turn >= 20) s.push('sentry');
  if (turn >= 28) s.push('slack');
  return [...core, ...s.flatMap(server)];
}
const hintAt = (turn: number) =>
  turn % 3 === 0
    ? `[kernel] tier 2 · friction ${String(turn % 7)} · pressure ${String(turn)}%`
    : undefined;
const GC_TURNS = new Set([15, 30, 37]);
const system: SystemBlock[] = [
  { text: pad(6000, 'system rules'), cacheBreakpoint: true },
  { text: pad(2000, 'project notes'), cacheBreakpoint: true },
];
const first: Message = {
  role: 'user',
  content: [
    { type: 'text', text: pad(3000, 'task frame') },
    { type: 'text', text: pad(800, 'living state') },
  ],
};
function turnMsgs(t: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${String(t)}`, name: 'read', input: { a: 'x' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: `t${String(t)}`,
          content: pad(1500, `output ${String(t)}`),
        },
      ],
    },
  ] as Message[];
}
/** GC: drop old tool outputs except the last 4 turns. */
function gc(msgs: Message[]): Message[] {
  return msgs.map((m, i) =>
    i > 0 && i < msgs.length - 8 && m.role === 'user'
      ? ({
          ...m,
          content: [
            {
              type: 'tool_result',
              toolUseId: (m.content[0] as { toolUseId: string }).toolUseId,
              content: '[gc]',
            },
          ],
        } as Message)
      : m,
  );
}

const provider = new AnthropicProvider({ apiKey: 'sim', cacheTtl: '5m', timeoutMs: 1 });
const tok = (v: unknown) => estimateTokens(v);

/** Anthropic-like prefix cache: chained block hashes; breakpoints write, any cached position reads. */
function simulate(policy: 'naive' | 'frozen-tools' | 'frozen+directive' | 'full') {
  const store = new Set<string>();
  let messages: Message[] = [first];
  const ep = new ToolEpoch();
  let billed = 0;
  let uncachedBaseline = 0;
  let read = 0;
  let totalIn = 0;
  let pendingFold = false;
  for (let t = 1; t <= TURNS; t++) {
    if (GC_TURNS.has(t)) {
      const next = gc(messages);
      let n = 0;
      while (n < next.length && JSON.stringify(next[n]) === JSON.stringify(messages[n])) n++;
      const pays =
        policy !== 'full' ||
        foldPaysOff({
          freedTokens: tok(messages) - tok(next),
          expectedRemainingTurns: TURNS - t,
          suffixTokensToBust: tok(next.slice(n)),
        });
      if (pays) {
        messages = next;
        pendingFold = true;
      }
    }
    const mounted = mountedAt(t);
    let tools: ToolSpec[];
    let sys = system;
    const directive: string[] = [];
    const hint = hintAt(t);
    if (policy === 'naive') {
      tools = mounted.map(toolSpec);
      sys = withKernelHint(system, hint);
    } else {
      const p = ep.plan({
        mounted,
        fold: policy === 'full' ? pendingFold : false,
        suffixTokens: tok(system) + tok(messages),
        foldBustTokens: tok(system) + tok(messages.slice(0, 1)),
        expectedRemainingTurns: TURNS - t,
      });
      tools = p.specs;
      const cd = capabilityDirective(p.extra);
      if (cd) directive.push(cd);
      if (policy === 'frozen-tools') sys = withKernelHint(system, hint);
      else if (hint) directive.push(hint);
    }
    pendingFold = false;
    const params = provider.buildParams(
      turnRequest(
        { system: sys, tools },
        messages,
        'sim',
        100,
        undefined,
        directive.length ? { terminalDirective: directive.join('\n\n') } : undefined,
      ),
    );
    // Linearize wire blocks in prefix order.
    const blocks: { v: unknown; bp: boolean }[] = [
      ...params.tools.map((x) => ({ v: x, bp: 'cache_control' in x })),
      ...(params.system as object[]).map((x) => ({ v: x, bp: 'cache_control' in x })),
      ...params.messages.flatMap((m) =>
        (m.content as object[]).map((c) => ({ v: { r: m.role, c }, bp: 'cache_control' in c })),
      ),
    ];
    let h = '';
    let pos = 0;
    let hitTok = 0;
    let lastBpTok = 0;
    const bpHashes: string[] = [];
    for (const b of blocks) {
      const clean = JSON.stringify(b.v, (k, x) => (k === 'cache_control' ? undefined : x));
      h = createHash('sha1')
        .update(h + clean)
        .digest('hex');
      pos += tok(clean);
      if (store.has(h)) hitTok = pos;
      if (b.bp) {
        lastBpTok = pos;
        bpHashes.push(h);
      }
    }
    for (const x of bpHashes) store.add(x);
    const write = Math.max(0, lastBpTok - hitTok);
    const unc = pos - hitTok - write;
    billed += hitTok * 0.1 + write * 1.25 + unc;
    uncachedBaseline += pos;
    read += hitTok;
    totalIn += pos;
    messages = [...messages, ...turnMsgs(t)];
  }
  return {
    policy,
    billedTokEq: Math.round(billed),
    vsUncached: billed / uncachedBaseline,
    hitPct: (100 * read) / totalIn,
    savedTokEq: Math.round(uncachedBaseline - billed),
  };
}

const rows = (['naive', 'frozen-tools', 'frozen+directive', 'full'] as const).map(simulate);
console.log('policy             billed(tok-eq)  x-uncached  cache-hit%  saved(tok-eq)');
for (const r of rows)
  console.log(
    `${r.policy.padEnd(18)} ${String(r.billedTokEq).padStart(14)}  ${r.vsUncached.toFixed(3).padStart(10)}  ${r.hitPct.toFixed(1).padStart(9)}%  ${String(r.savedTokEq).padStart(13)}`,
  );
