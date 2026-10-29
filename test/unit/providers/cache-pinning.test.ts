import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import {
  cacheKeyFor,
  lastStableIndex,
  PIN_PROFILES,
  pinPrefix,
  prefixHash,
  prefixQuality,
  profileFor,
  stableBlocks,
  volatileBlocks,
} from '../../../src/providers/cache-pinning.js';
import type { CompletionRequest, SystemBlock, ToolSpec } from '../../../src/providers/types.js';

const SYSTEM: SystemBlock[] = [
  { text: 'You are a helpful assistant.', volatile: false },
  { text: 'Goal: ship the feature.', volatile: true },
  { text: 'Tools: edit, read.', volatile: false },
  { text: 'Cycle: 1', volatile: true },
];

const TOOLS: ToolSpec[] = [
  {
    name: 'read',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

describe('cache pinning', () => {
  it('splits stable and volatile blocks', () => {
    expect(stableBlocks(SYSTEM).map((b) => b.text)).toEqual([
      'You are a helpful assistant.',
      'Tools: edit, read.',
    ]);
    expect(volatileBlocks(SYSTEM).map((b) => b.text)).toEqual([
      'Goal: ship the feature.',
      'Cycle: 1',
    ]);
  });

  it('finds the last stable block', () => {
    expect(lastStableIndex(SYSTEM)).toBe(2);
    expect(lastStableIndex([{ text: 'a', volatile: true }])).toBe(-1);
    expect(lastStableIndex([])).toBe(-1);
  });

  it('returns a stable prefix hash', () => {
    const a = prefixHash({ system: SYSTEM, tools: TOOLS });
    expect(a).toHaveLength(64);
    expect(prefixHash({ system: SYSTEM, tools: TOOLS })).toBe(a);
    // A changed tool schema changes the hash.
    const firstTool = TOOLS[0];
    if (!firstTool) throw new Error('no tool spec');
    const changedTool: ToolSpec = {
      name: firstTool.name,
      description: 'changed',
      inputSchema: firstTool.inputSchema,
    };
    expect(prefixHash({ system: SYSTEM, tools: [changedTool] })).not.toBe(a);
  });

  it('pins stable blocks before volatile ones', () => {
    const pinned = pinPrefix(SYSTEM);
    expect(pinned.map((b) => b.text)).toEqual([
      'You are a helpful assistant.',
      'Tools: edit, read.',
      'Goal: ship the feature.',
      'Cycle: 1',
    ]);
    const lastStable = pinned[1];
    const firstVolatile = pinned[2];
    const secondVolatile = pinned[3];
    if (!lastStable || !firstVolatile || !secondVolatile) throw new Error('missing pinned blocks');
    // The last stable block gets the breakpoint.
    expect(lastStable.cacheBreakpoint).toBe(true);
    // Volatile blocks never get a breakpoint.
    expect(firstVolatile.cacheBreakpoint).toBeUndefined();
    expect(secondVolatile.cacheBreakpoint).toBeUndefined();
  });

  it('keeps relative order of stable blocks', () => {
    const order = SYSTEM.filter((b) => !b.volatile).map((b) => b.text);
    const pinned = pinPrefix(SYSTEM)
      .slice(0, 2)
      .map((b) => b.text);
    expect(pinned).toEqual(order);
  });

  it('profiles providers', () => {
    expect(profileFor('anthropic')).toEqual(PIN_PROFILES.anthropic);
    expect(profileFor('openai')).toEqual(PIN_PROFILES.openai);
    expect(profileFor('openrouter')).toEqual(PIN_PROFILES.openai);
    expect(profileFor('litellm')).toEqual(PIN_PROFILES.openai);
    expect(profileFor('deepseek')).toEqual(PIN_PROFILES.deepseek);
    expect(profileFor('inception')).toEqual(PIN_PROFILES.inception);
    expect(profileFor('unknown-vendor')).toEqual(PIN_PROFILES.generic);
  });

  it('measures prefix quality', () => {
    const longSystem: SystemBlock[] = [
      { text: 'You are a helpful assistant. '.repeat(200), volatile: false },
      ...SYSTEM.slice(1),
    ];
    const req = {
      system: longSystem,
      tools: TOOLS,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
    };
    const q = prefixQuality(req, profileFor('anthropic'));
    expect(q.stableTokens).toBeGreaterThan(0);
    expect(q.stability).toBeGreaterThan(0);
    expect(q.stability).toBeLessThanOrEqual(1);
    expect(q.cacheable).toBe(true);
    expect(q.hash).toHaveLength(64);
    // A too-small stable prefix is not cacheable.
    const tiny = prefixQuality(
      { system: [{ text: 'hi', volatile: false }], tools: [], messages: [] },
      profileFor('anthropic'),
    );
    expect(tiny.cacheable).toBe(false);
  });

  it('derives a stable cache key', () => {
    const a = cacheKeyFor('run-1', 'abcdef0123456789');
    expect(a).toBe('omnexx-run-1-abcdef0123456789');
    // The same inputs give the same key.
    expect(cacheKeyFor('run-1', 'abcdef0123456789')).toBe(a);
  });

  it('guarantees AnthropicProvider builds params with stable blocks first and breakpoint on last stable', () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      cacheTtl: '5m',
      prefixTtl: '1h',
      timeoutMs: 1000,
    });
    // Volatile block intentionally placed before a stable block:
    const mixedSystem: SystemBlock[] = [
      { text: 'Dynamic Goal', volatile: true },
      { text: 'Core System Instructions', volatile: false },
      { text: 'Dynamic Notes', volatile: true },
      { text: 'Immutable Formatting Rules', volatile: false },
      { text: 'Cycle 3 State', volatile: true },
    ];
    const dummyReq: CompletionRequest = {
      model: 'claude-sonnet-5-5',
      system: mixedSystem,
      tools: TOOLS,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
      messageBreakpoints: [],
    };
    const params = provider.buildParams(dummyReq);
    const system = params.system as { text: string; cache_control?: { ttl?: string } }[];

    // Expect stable blocks placed first
    expect(system.map((s) => s.text)).toEqual([
      'Core System Instructions',
      'Immutable Formatting Rules',
      'Dynamic Goal',
      'Dynamic Notes',
      'Cycle 3 State',
    ]);

    // Breakpoint must be exclusively on the last stable block (index 1)
    expect(system[0]?.cache_control).toBeUndefined();
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[2]?.cache_control).toBeUndefined();
    expect(system[3]?.cache_control).toBeUndefined();
    expect(system[4]?.cache_control).toBeUndefined();
  });
});
