import { describe, expect, it } from 'vitest';
import { PRUNED_PREFIX, pruneRules } from '../../../src/agent/prune-rules.js';
import type { Message } from '../../../src/providers/types.js';

const big = (tag: string, n = 2_000) => `${tag}\n${'x'.repeat(n)}`;
let ids = 0;

/** One turn: an assistant tool call (with optional narration) and its result. */
function turn(
  name: string,
  input: Record<string, unknown>,
  result: string,
  opts: { isError?: boolean; say?: string } = {},
): Message[] {
  const id = `t${String(ids++)}`;
  return [
    {
      role: 'assistant',
      content: [
        ...(opts.say ? [{ type: 'text' as const, text: opts.say }] : []),
        { type: 'tool_use', id, name, input },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: id,
          content: result,
          ...(opts.isError ? { isError: true } : {}),
        },
      ],
    },
  ];
}

const goal: Message = { role: 'user', content: [{ type: 'text', text: 'fix add()' }] };
const resultAt = (m: Message[], i: number): string => {
  const b = m[i]?.content.find((x) => x.type === 'tool_result');
  return b?.type === 'tool_result' ? b.content : '';
};
const textAt = (m: Message[], i: number): string => {
  const b = m[i]?.content.find((x) => x.type === 'text');
  return b?.type === 'text' ? b.text : '';
};

describe('pruneRules', () => {
  it('stubs a read made stale by a later edit of the same file', () => {
    const msgs = [
      goal,
      ...turn('read', { path: 'src/a.ts' }, big('a.ts v1')),
      ...turn('str_replace', { path: 'src/a.ts' }, 'edited src/a.ts'),
    ];
    const r = pruneRules(msgs, 10);
    expect(r.byRule.stale_read).toBe(1);
    expect(resultAt(r.messages, 2)).toMatch(/^\[pruned by omnexx: src\/a\.ts was edited/);
    // The call stays paired with its (stubbed) result.
    expect(r.messages[1]?.content[0]).toMatchObject({ type: 'tool_use' });
  });

  it('keeps a read of a file edited before it, or of a different file', () => {
    const msgs = [
      goal,
      ...turn('str_replace', { path: 'src/a.ts' }, 'edited'),
      ...turn('read', { path: 'src/a.ts' }, big('a.ts v2')),
      ...turn('read', { path: 'src/b.ts' }, big('b.ts')),
      ...turn('write_file', { path: 'src/c.ts' }, 'wrote'),
    ];
    expect(pruneRules(msgs, 10).pruned).toBe(0);
  });

  it('stubs a failed edit once a later edit of the file succeeded', () => {
    const msgs = [
      goal,
      ...turn('str_replace', { path: 'src/a.ts' }, big('old_str not found'), { isError: true }),
      ...turn('str_replace', { path: 'src/a.ts' }, 'edited'),
    ];
    const r = pruneRules(msgs, 10);
    expect(r.byRule.failed_edit).toBe(1);
    expect(resultAt(r.messages, 2)).toContain('a later edit succeeded');
  });

  it('stubs a search whose every file was read afterwards, not one with unread hits', () => {
    const hits = Array.from(
      { length: 30 },
      (_, i) => `src/a.ts:${String(i)}: add(${'y'.repeat(30)})`,
    );
    const covered = [
      goal,
      ...turn('search', { pattern: 'add' }, hits.join('\n')),
      ...turn('read', { path: 'src/a.ts' }, big('a.ts')),
    ];
    expect(pruneRules(covered, 10).byRule.covered_search).toBe(1);
    const mixed = [...hits, ...hits.map((h) => h.replace('src/a.ts', 'src/other.ts'))];
    const partly = [
      goal,
      ...turn('search', { pattern: 'add' }, mixed.join('\n')),
      ...turn('read', { path: 'src/a.ts' }, big('a.ts')),
    ];
    expect(pruneRules(partly, 10).byRule.covered_search).toBe(0);
  });

  it('shortens narration of old turns but keeps the last K turns and signed turns whole', () => {
    const say = `Let me look at the add function and see what it does with ${'its inputs '.repeat(20)}`;
    const msgs = [
      goal,
      ...turn('bash', { command: 'ls' }, 'a', { say }),
      ...turn('bash', { command: 'pwd' }, 'b', { say }),
      ...turn('bash', { command: 'id' }, 'c', { say }),
    ];
    const r = pruneRules(msgs, 2);
    expect(r.byRule.narration).toBe(1);
    expect(textAt(r.messages, 1).startsWith(PRUNED_PREFIX)).toBe(true);
    expect(textAt(r.messages, 3)).toBe(say);
    expect(textAt(r.messages, 5)).toBe(say);

    const signed = msgs.map((m, i) =>
      i === 1
        ? { ...m, content: [{ type: 'opaque' as const, provider: 'x', block: {} }, ...m.content] }
        : m,
    );
    expect(pruneRules(signed, 2).byRule.narration).toBe(0);
  });

  it('leaves small results, earlier stubs and the input alone', () => {
    const msgs = [
      goal,
      ...turn('read', { path: 'src/a.ts' }, 'short'),
      ...turn('read', { path: 'src/b.ts' }, `[cleared by omnexx: ${'z'.repeat(500)}]`),
      ...turn('str_replace', { path: 'src/a.ts' }, 'edited'),
      ...turn('str_replace', { path: 'src/b.ts' }, 'edited'),
    ];
    const before = JSON.stringify(msgs);
    const r = pruneRules(msgs, 10);
    expect(r.pruned).toBe(0);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});
