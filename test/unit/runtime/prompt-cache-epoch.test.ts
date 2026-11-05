/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-deprecated */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { turnRequest } from '../../../src/agent/context.js';
import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import type { Message, SystemBlock } from '../../../src/providers/types.js';
import {
  CALL_CAPABILITY,
  ToolEpoch,
  capabilityDirective,
  foldPaysOff,
} from '../../../src/runtime/kernel/cache-epoch.js';
import type { Tool, ToolContext } from '../../../src/tools/types.js';

const mk = (name: string, out = name): Tool =>
  ({
    name,
    description: `${name} tool`,
    schema: z.object({ q: z.string() }),
    readOnly: true,
    run: async (i: { q: string }) => ({ content: `${out}:${i.q}` }),
  }) as unknown as Tool;

const core = [mk('read'), mk('edit'), mk('bash'), mk('manage_capabilities')];
const system: SystemBlock[] = [
  { text: 'base rules', cacheBreakpoint: true },
  { text: 'goal', cacheBreakpoint: true },
  { text: 'notes', cacheBreakpoint: true },
];
const provider = new AnthropicProvider({ apiKey: 'test', cacheTtl: '5m', timeoutMs: 1000 });
const msgs = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `m${i}` }],
  }));

/** Hash of everything up to and including the cached-last message on the wire. */
function prefixHash(params: ReturnType<AnthropicProvider['buildParams']>, upTo: number): string {
  const strip = (v: unknown) =>
    JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
  return createHash('sha256')
    .update(
      JSON.stringify(strip([params.tools, params.system, params.messages.slice(0, upTo + 1)])),
    )
    .digest('hex');
}

const countCc = (v: unknown): number => (JSON.stringify(v).match(/"cache_control"/g) ?? []).length;

describe('prompt-cache epochs', () => {
  it('keeps the prefix byte-identical when an MCP capability is mounted and called mid-chat', async () => {
    const ep = new ToolEpoch();
    const t1 = ep.plan({ mounted: core, suffixTokens: 50_000 });
    const m = msgs(5);
    const p1 = provider.buildParams(turnRequest({ system, tools: t1.specs }, m, 'claude', 100));
    // Mid-chat: kernel mounts a GitHub MCP tool.
    const gh = mk('mcp__github__search_issues', 'gh');
    const t2 = ep.plan({ mounted: [...core, gh], suffixTokens: 50_000 });
    expect(t2.rebaked).toBe(false);
    expect(t2.specs).toEqual(t1.specs);
    expect(t2.extra.map((s) => s.name)).toEqual(['mcp__github__search_issues']);
    const directive = capabilityDirective(t2.extra)!;
    const m2 = [...m, ...msgs(2)];
    const p2 = provider.buildParams(
      turnRequest({ system, tools: t2.specs }, m2, 'claude', 100, undefined, {
        terminalDirective: directive,
      }),
    );
    expect(prefixHash(p2, 4)).toBe(prefixHash(p1, 4));
    // The new capability is callable both directly and via the proxy.
    const ctx = {} as ToolContext;
    expect((await t2.byName.get(gh.name)!.run({ q: 'x' }, ctx)).content).toBe('gh:x');
    const proxied = await t2.byName
      .get(CALL_CAPABILITY)!
      .run({ tool_name: gh.name, arguments: { q: 'y' } }, ctx);
    expect(proxied.content).toBe('gh:y');
    const bad = await t2.byName.get(CALL_CAPABILITY)!.run({ tool_name: 'nope' }, ctx);
    expect(bad.isError).toBe(true);
  });

  it('re-bakes tools only at a fold (epoch boundary)', () => {
    const ep = new ToolEpoch();
    ep.plan({ mounted: core, suffixTokens: 50_000 });
    const extra = [1, 2, 3, 4, 5].map((i) => mk(`mcp__x__op${String(i)}`));
    // Mid-epoch: extras stay outside the prefix.
    expect(ep.plan({ mounted: [...core, ...extra], suffixTokens: 50_000 }).rebaked).toBe(false);
    // A long-running chat folding a small prefix: re-baking pays off.
    const t = ep.plan({
      mounted: [...core, ...extra],
      fold: true,
      suffixTokens: 50_000,
      foldBustTokens: 100,
      expectedRemainingTurns: 200,
    });
    expect(t.rebaked).toBe(true);
    expect(t.extra).toEqual([]);
    expect(t.specs.map((s) => s.name)).toContain('mcp__x__op1');
    expect(t.epoch).toBe(2);
  });

  it('emits at most 4 cache_control blocks, tools cached, hints after the message breakpoints', () => {
    const p = provider.buildParams(
      turnRequest(
        {
          system,
          tools: core.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: 'object' },
          })),
        },
        msgs(7),
        'claude',
        100,
        undefined,
        {
          terminalDirective: '[kernel] hint',
        },
      ),
    );
    expect(countCc(p)).toBeLessThanOrEqual(4);
    expect(countCc(p.tools?.at(-1))).toBe(1);
    expect(countCc(p.system)).toBe(1);
    const idx = p.messages.findIndex((m) => JSON.stringify(m).includes('[kernel] hint'));
    expect(idx).toBe(p.messages.length - 1);
    const lastCached = p.messages.reduce((a, m, i) => (countCc(m) ? i : a), -1);
    expect(lastCached).toBeLessThan(idx);
    expect(countCc(p.messages[0])).toBe(1);
  });

  it('cache-amortization inequality', () => {
    // Freeing 20k tokens over 10 turns at 0.1x does not pay for rewriting a 40k suffix.
    expect(
      foldPaysOff({ freedTokens: 20_000, expectedRemainingTurns: 10, suffixTokensToBust: 40_000 }),
    ).toBe(false);
    // Freeing 80k for 30 turns re-caching only a 5k suffix does.
    expect(
      foldPaysOff({ freedTokens: 80_000, expectedRemainingTurns: 30, suffixTokensToBust: 5_000 }),
    ).toBe(true);
  });
});
