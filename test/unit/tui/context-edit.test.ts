import { describe, expect, it } from 'vitest';
import type { Message, SystemBlock, ToolSpec } from '../../../src/providers/types.js';
import {
  applyContext,
  clearContextHistory,
  deleteContextItem,
  EMPTY_OVERRIDES,
  listContext,
  updateContextItem,
} from '../../../src/tui/context-edit.js';

const system: SystemBlock[] = [
  { text: 'You are omnexx.' },
  { text: '# Repo map', cacheBreakpoint: true },
];
const tools: ToolSpec[] = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'bash', description: 'Run a command', inputSchema: { type: 'object' } },
];
const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running them.' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'npm test' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '2 failed' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
];
const base = { system, tools, history, overrides: EMPTY_OVERRIDES };

describe('listContext', () => {
  it('lists system blocks, tools and every history block with token counts', () => {
    const items = listContext(base);
    expect(items.map((i) => i.id)).toEqual([
      'system:0',
      'system:1',
      'tool:read',
      'tool:bash',
      'chat:0:0',
      'chat:1:0',
      'chat:1:1',
      'chat:2:0',
      'chat:3:0',
    ]);
    expect(items.every((i) => i.tokens > 0)).toBe(true);
    expect(items.find((i) => i.id === 'chat:1:1')).toMatchObject({
      group: 'chat',
      kind: 'tool_use',
      label: 'Tool call: bash',
      text: '{\n  "cmd": "npm test"\n}',
    });
    expect(items.find((i) => i.id === 'chat:2:0')?.label).toBe('Tool result: bash');
    expect(items[0]?.edited).toBe(false);
  });
});

describe('updateContextItem', () => {
  it('overrides a system block without touching the original', () => {
    const next = updateContextItem(base, 'system:0', 'Be terse.');
    expect(system[0]?.text).toBe('You are omnexx.');
    expect(applyContext(next).system[0]).toEqual({ text: 'Be terse.' });
    expect(applyContext(next).system[1]).toEqual(system[1]);
    expect(listContext(next)[0]?.edited).toBe(true);
  });

  it('overrides a tool description', () => {
    const next = updateContextItem(base, 'tool:bash', 'Shell');
    expect(applyContext(next).tools.find((t) => t.name === 'bash')?.description).toBe('Shell');
    expect(tools[1]?.description).toBe('Run a command');
  });

  it('edits chat text, tool results and tool-call input', () => {
    let next = updateContextItem(base, 'chat:0:0', 'fix only parser tests');
    next = updateContextItem(next, 'chat:2:0', '1 failed');
    next = updateContextItem(next, 'chat:1:1', '{"cmd":"npm test -- parser"}');
    expect(next.history[0]?.content[0]).toEqual({ type: 'text', text: 'fix only parser tests' });
    expect(next.history[2]?.content[0]).toMatchObject({ content: '1 failed' });
    expect(next.history[1]?.content[1]).toMatchObject({ input: { cmd: 'npm test -- parser' } });
    expect(history[0]?.content[0]).toEqual({ type: 'text', text: 'fix the tests' });
  });

  it('rejects tool-call input that is not JSON, and unknown ids', () => {
    expect(() => updateContextItem(base, 'chat:1:1', 'not json')).toThrow(/JSON/);
    expect(() => updateContextItem(base, 'chat:9:0', 'x')).toThrow(/no context item/);
    expect(() => updateContextItem(base, 'nope', 'x')).toThrow(/no context item/);
  });
});

describe('deleteContextItem', () => {
  it('removes a tool call together with its result and drops emptied messages', () => {
    const next = deleteContextItem(base, 'chat:1:1');
    expect(next.history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running them.' },
          { type: 'text', text: 'Fixed.' },
        ],
      },
    ]);
    expect(history).toHaveLength(4);
  });

  it('removes a tool result together with its call', () => {
    const next = deleteContextItem(base, 'chat:2:0');
    expect(JSON.stringify(next.history)).not.toContain('t1');
  });

  it('hides system blocks and tools', () => {
    let next = deleteContextItem(base, 'system:0');
    next = deleteContextItem(next, 'tool:read');
    const applied = applyContext(next);
    expect(applied.system).toEqual([system[1]]);
    expect(applied.tools.map((t) => t.name)).toEqual(['bash']);
    expect(listContext(next).find((i) => i.id === 'tool:read')?.removed).toBe(true);
  });
});

describe('clearContextHistory', () => {
  it('clears all conversation messages and tool calls/results while preserving system and tools', () => {
    const cleared = clearContextHistory(base);
    expect(cleared.history).toEqual([]);
    expect(cleared.system).toEqual(system);
    expect(cleared.tools).toEqual(tools);
    const items = listContext(cleared);
    expect(items.some((i) => i.group === 'chat')).toBe(false);
    expect(items.filter((i) => i.group === 'system')).toHaveLength(2);
    expect(items.filter((i) => i.group === 'tools')).toHaveLength(2);
  });
});
