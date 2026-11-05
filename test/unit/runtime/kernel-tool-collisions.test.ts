import { describe, expect, it } from 'vitest';
import { dedupeToolsByName } from '../../../src/runtime/kernel/kernel.js';
import { fakeTool } from './kernel-test-helpers.js';

describe('bug #23: duplicate tool names are reported, first wins', () => {
  it('keeps the first tool per name and lists collisions', () => {
    const a = fakeTool('search_capabilities', { description: 'meta' });
    const b = fakeTool('search_capabilities', { description: 'mcp' });
    const { tools, collisions } = dedupeToolsByName([fakeTool('read'), a, b]);
    expect(tools.map((t) => t.description)).toEqual(['read', 'meta']);
    expect(collisions).toEqual(['search_capabilities']);
  });
});
