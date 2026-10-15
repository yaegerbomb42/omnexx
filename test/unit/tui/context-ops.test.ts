import { describe, expect, it } from 'vitest';
import type { Message, SystemBlock, ToolSpec } from '../../../src/providers/types.js';
import {
  addContextNote,
  applyContext,
  deleteContextItem,
  EMPTY_OVERRIDES,
  listContext,
  NOTE_HEADING,
  pinContextItem,
  restoreContextItem,
  toolSource,
  updateContextItem,
} from '../../../src/tui/context-edit.js';
import {
  budgetBar,
  contextTransform,
  parseContextCommand,
  renderContext,
} from '../../../src/tui/context-ops.js';

const system: SystemBlock[] = [
  { text: 'You are omnexx.' },
  { text: '# Project instructions\n\n### CLAUDE.md\n\nUse tabs.' },
  { text: '# Codebase map (path)', cacheBreakpoint: true },
];
const tools: ToolSpec[] = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'skill', description: 'Load a skill', inputSchema: { type: 'object' } },
  { name: 'mcp__github__search', description: 'Search', inputSchema: { type: 'object' } },
];
const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
];
const base = { system, tools, history, overrides: EMPTY_OVERRIDES };

describe('context sources', () => {
  it('labels where each system block and tool comes from', () => {
    const items = listContext(base);
    expect(items.find((i) => i.id === 'system:0')?.source).toBe('Omnexx');
    expect(items.find((i) => i.id === 'system:1')?.source).toBe('CLAUDE.md / AGENTS.md');
    expect(items.find((i) => i.id === 'system:2')?.source).toBe('Repo map');
    expect(items.find((i) => i.id === 'tool:skill')?.source).toBe('Skills');
    expect(items.find((i) => i.id === 'tool:mcp__github__search')?.source).toBe('MCP: github');
    expect(toolSource('read')).toBe('Built-in');
  });
});

describe('notes, pins and restore', () => {
  it('adds a note that the next request sends after the system prompt', () => {
    const next = addContextNote(base, 'Prefer small commits.');
    const sent = applyContext(next).system;
    expect(sent).toHaveLength(system.length + 1);
    expect(sent.at(-1)?.text).toBe(`${NOTE_HEADING}\n\nPrefer small commits.`);
    expect(listContext(next).find((i) => i.id === 'note:1')).toMatchObject({
      group: 'notes',
      source: 'Your note',
    });
    expect(base.overrides.notes).toEqual([]);
  });

  it('edits and deletes a note', () => {
    let next = addContextNote(base, 'one');
    next = addContextNote(next, 'two');
    next = updateContextItem(next, 'note:1', 'uno');
    next = deleteContextItem(next, 'note:2');
    expect(next.overrides.notes).toEqual([{ id: '1', text: 'uno', pinned: false }]);
  });

  it('refuses an empty note', () => {
    expect(() => addContextNote(base, '  ')).toThrow(/needs some text/);
  });

  it('pins a chat item as a note, so it outlives the history', () => {
    const pinned = pinContextItem(base, 'chat:0:0');
    const trimmed = { ...pinned, history: [] };
    expect(applyContext(trimmed).system.at(-1)?.text).toContain('fix the tests');
    expect(listContext(trimmed).find((i) => i.group === 'notes')?.source).toBe('Pinned from chat');
    expect(() => pinContextItem(base, 'tool:read')).toThrow(/only chat items/);
  });

  it('restores one hidden tool and one edited block, leaving the rest', () => {
    let next = deleteContextItem(base, 'tool:read');
    next = deleteContextItem(next, 'tool:skill');
    next = updateContextItem(next, 'system:0', 'edited');
    next = restoreContextItem(next, 'tool:read');
    next = restoreContextItem(next, 'system:0');
    const sent = applyContext(next);
    expect(sent.tools.map((t) => t.name)).toEqual(['read', 'mcp__github__search']);
    expect(sent.system[0]?.text).toBe('You are omnexx.');
    expect(() => restoreContextItem(next, 'chat:0:0')).toThrow(/default to restore/);
  });
});

describe('/context', () => {
  it('parses every verb', () => {
    expect(parseContextCommand([])).toEqual({ kind: 'list' });
    expect(parseContextCommand(['show', 'tool:read'])).toEqual({ kind: 'show', id: 'tool:read' });
    expect(parseContextCommand(['edit', 'system:0', 'be', 'brief'])).toEqual({
      kind: 'change',
      change: { op: 'edit', id: 'system:0', text: 'be brief' },
    });
    expect(parseContextCommand(['hide', 'tool:read']).kind).toBe('change');
    expect(parseContextCommand(['note', 'use', 'pnpm'])).toEqual({
      kind: 'change',
      change: { op: 'add', text: 'use pnpm' },
    });
    expect(parseContextCommand(['reset'])).toEqual({ kind: 'change', change: { op: 'reset' } });
    expect(() => parseContextCommand(['note'])).toThrow(/usage/);
    expect(() => parseContextCommand(['frob', 'x'])).toThrow(/usage/);
  });

  it('applies pure changes', () => {
    const next = contextTransform({ op: 'add', text: 'hi' })(base);
    expect(next.overrides.notes).toHaveLength(1);
  });

  it('renders groups, ids, sources and a budget bar', () => {
    const text = renderContext(listContext(addContextNote(base, 'mine')), 1000);
    expect(text).toMatch(/^Context next turn \[#*-*\] .* \/ 1\.0k \(\d+%\)/);
    expect(text).toContain('System prompt');
    expect(text).toContain('Your notes');
    expect(text).toMatch(/tool:mcp__github__search.*MCP: github/);
    expect(renderContext([], 1000)).toMatch(/send a message first/);
    expect(budgetBar(500, 1000)).toContain('(50%)');
    expect(budgetBar(10, 0)).toBe('10 tokens');
  });
});
