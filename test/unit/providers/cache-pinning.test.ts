import { describe, expect, it } from 'vitest';
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
import type { SystemBlock, ToolSpec } from '../../../src/providers/types.js';

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
    const changedTool: ToolSpec = {
      name: TOOLS[0]!.name,
      description: 'changed',
      inputSchema: TOOLS[0]!.inputSchema,
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
    // The last stable block gets the breakpoint.
    expect(pinned[1]!.cacheBreakpoint).toBe(true);
    // Volatile blocks never get a breakpoint.
    expect(pinned[2]!.cacheBreakpoint).toBeUndefined();
    expect(pinned[3]!.cacheBreakpoint).toBeUndefined();
  });

  it('keeps relative order of stable blocks', () => {
    const order = SYSTEM.filter((b) => !b.volatile).map((b) => b.text);
    const pinned = pinPrefix(SYSTEM).slice(0, 2).map((b) => b.text);
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
});
