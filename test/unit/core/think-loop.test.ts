import { describe, expect, it } from 'vitest';
import type { LoopEnd, LoopResult } from '../../../src/agent/loop.js';
import type { Message } from '../../../src/providers/types.js';
import {
  continueWith,
  DECIDE_PROMPT,
  EXECUTE_PROMPT,
  runThinkLoop,
  THINK_PROMPT,
  type ChainKind,
  type CheckOutcome,
  type Segment,
  type SessionIO,
} from '../../../src/core/think-loop.js';

const text = (m: Message | undefined): string =>
  (m?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');

interface Reply {
  say: string;
  end?: LoopEnd;
  stuck?: { signal: string; detail: string };
}

/** A fake session: each segment answers with the next scripted reply; checks come from a list. */
function fakeIO(replies: Reply[], checks: CheckOutcome[], findings: (string | undefined)[] = []) {
  const calls: { seg: Segment; chain: ChainKind }[] = [];
  const events: string[] = [];
  const log: { type: string; data: Record<string, unknown> }[] = [];
  const restored: string[] = [];
  let checked = 0;
  const io: SessionIO = {
    segment: (seg, chain) => {
      calls.push({ seg, chain });
      const r = replies[calls.length - 1] ?? { say: 'done' };
      const messages: Message[] = [
        ...seg.history,
        seg.first,
        { role: 'assistant', content: [{ type: 'text', text: r.say }] },
      ];
      const out: LoopResult = {
        end: r.end ?? 'done',
        turns: 1,
        finalText: r.say,
        usage: { uncached: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 },
        usd: 0.01,
        messages,
        ...(r.stuck ? { stuck: r.stuck as LoopResult['stuck'] & object } : {}),
      };
      return Promise.resolve(out);
    },
    check: () => {
      const c = checks[checked++];
      if (!c) throw new Error('no more checks scripted');
      return Promise.resolve(c);
    },
    review: () => Promise.resolve(findings.shift()),
    restore: (tree) => {
      restored.push(tree);
      return Promise.resolve();
    },
    emit: (type, data) => {
      events.push(type);
      log.push({ type, data });
    },
  };
  return { io, calls, events, restored, log };
}

const pass = (tree: string): CheckOutcome => ({ pass: true, failures: '', signature: '', tree });
const fail = (why: string, tree = 't-red'): CheckOutcome => ({
  pass: false,
  failures: why,
  signature: why,
  tree,
});
const first: Message = { role: 'user', content: [{ type: 'text', text: 'Work on M1.T01' }] };
const limits = { rounds: 6, rethinks: 2, thinkTurns: 8 };

describe('think-first loop session', () => {
  it('shows the analysis steps as the todo list and ticks them off once green', async () => {
    const analysis =
      '1. Framing: x\n4. Ordered steps:\n   - fix sum()\n   - add a test\n5. Verify: npm test';
    const { io, log } = fakeIO([{ say: analysis }, { say: 'fixed' }], [pass('t1')]);
    await runThinkLoop(first, io, limits);
    const todos = log.filter((e) => e.type === 'todo.update').map((e) => e.data.items);
    expect(todos).toEqual([
      [
        { text: 'fix sum()', status: 'in_progress' },
        { text: 'add a test', status: 'pending' },
      ],
      [
        { text: 'fix sum()', status: 'done' },
        { text: 'add a test', status: 'done' },
      ],
    ]);
  });

  it('thinks first with the strong chain, and the analysis stays in the conversation it executes in', async () => {
    const { io, calls } = fakeIO(
      [{ say: 'ANALYSIS: the bug is the off-by-one in sum()' }, { say: 'fixed' }],
      [pass('t1')],
    );
    const out = await runThinkLoop(first, io, limits);
    expect(calls.map((c) => c.chain)).toEqual(['think', 'work']);
    expect(calls[0]?.seg.history).toEqual([]);
    expect(text(calls[0]?.seg.first)).toContain('Work on M1.T01');
    expect(text(calls[0]?.seg.first)).toContain(THINK_PROMPT);
    // Execution continues the same conversation: the analysis is there verbatim, not re-summarized.
    expect(calls[1]?.seg.history.map(text)).toContain(
      'ANALYSIS: the bug is the off-by-one in sum()',
    );
    expect(text(calls[1]?.seg.first)).toBe(EXECUTE_PROMPT);
    // Compaction keeps the opening context and think instructions at the top.
    expect(calls[1]?.seg.anchor).toEqual(calls[0]?.seg.first);
    expect(out).toMatchObject({
      end: 'done',
      green: true,
      analysis: 'ANALYSIS: the bug is the off-by-one in sum()',
      turns: 2,
      rounds: 1,
    });
  });

  it('fixes forward on a failing check: the failure is the next message and nothing is restored', async () => {
    const { io, calls, restored, events } = fakeIO(
      [{ say: 'analysis' }, { say: 'first try' }, { say: 'fixed it' }],
      [fail('test sum: expected 3, got 2'), pass('t2')],
    );
    const out = await runThinkLoop(first, io, limits);
    expect(calls.map((c) => c.chain)).toEqual(['think', 'work', 'work']);
    expect(text(calls[2]?.seg.first)).toContain('expected 3, got 2');
    expect(text(calls[2]?.seg.first)).toContain('nothing was rolled back');
    expect(calls[2]?.seg.history.map(text)).toContain('first try');
    expect(restored).toEqual([]);
    expect(events).not.toContain('loop.restore_green');
    expect(out).toMatchObject({ end: 'done', green: true, rounds: 2 });
  });

  it('re-thinks in the same conversation when stuck, with the strong chain, then executes the revision', async () => {
    const { io, calls, events } = fakeIO(
      [
        { say: 'analysis' },
        {
          say: 'going round',
          end: 'stuck',
          stuck: { signal: 'no_edit', detail: '15 turns without an edit' },
        },
        { say: 'REVISED: the cache key was wrong' },
        { say: 'done now' },
      ],
      [pass('t3')],
    );
    const out = await runThinkLoop(first, io, limits);
    expect(calls.map((c) => c.chain)).toEqual(['think', 'work', 'think', 'work']);
    expect(text(calls[2]?.seg.first)).toMatch(/stuck: 15 turns without an edit.*re-think/s);
    expect(calls[2]?.seg.history.map(text)).toContain('going round');
    expect(events).toContain('loop.rethink');
    expect(out.analysis).toBe('REVISED: the cache key was wrong');
    expect(out.rethinks).toBe(1);
  });

  it('re-thinks when the same failure comes back twice', async () => {
    const { io, calls } = fakeIO(
      [{ say: 'a' }, { say: 'b' }, { say: 'c' }, { say: 'rethought' }, { say: 'e' }],
      [fail('same'), fail('same'), pass('t')],
    );
    await runThinkLoop(first, io, limits);
    expect(calls.map((c) => c.chain)).toEqual(['think', 'work', 'work', 'think', 'work']);
    expect(text(calls[3]?.seg.first)).toContain('the same checks still fail the same way');
  });

  it('turns a review finding into one more turn, then reviews no more', async () => {
    const { io, calls, restored } = fakeIO(
      [{ say: 'analysis' }, { say: 'done' }, { say: 'addressed the finding' }],
      [pass('t1'), pass('t2')],
      ['- [blocker] the empty input case is unhandled'],
    );
    const out = await runThinkLoop(first, io, limits);
    expect(calls.map((c) => c.chain)).toEqual(['think', 'work', 'work']);
    expect(text(calls[2]?.seg.first)).toContain('the empty input case is unhandled');
    expect(restored).toEqual([]);
    expect(out).toMatchObject({ end: 'done', reviewed: true, green: true });
  });

  it('does not count a review as settled when its fix was cut short', async () => {
    const { io } = fakeIO(
      [{ say: 'analysis' }, { say: 'done' }, { say: 'half way', end: 'max_tokens_per_cycle' }],
      [pass('t1'), pass('t2')],
      ['- [blocker] the empty input case is unhandled'],
    );
    const out = await runThinkLoop(first, io, limits);
    expect(out).toMatchObject({ reviewed: false, green: true });
  });

  it('goes back to the last green tree when the session ends red', async () => {
    const { io, restored, events } = fakeIO(
      [{ say: 'a' }, { say: 'b' }, { say: 'c' }, { say: 'd' }],
      [pass('green-1'), fail('x'), fail('y')],
      ['- [blocker] finding'],
    );
    const out = await runThinkLoop(first, io, { rounds: 3, rethinks: 0, thinkTurns: 8 });
    expect(restored).toEqual(['green-1']);
    expect(events).toContain('loop.restore_green');
    expect(out).toMatchObject({ green: true, rounds: 3 });
  });

  it('stops at once on a stop request or the money running out', async () => {
    const { io, calls } = fakeIO([{ say: 'a' }, { say: 'b', end: 'max_usd' }], []);
    const out = await runThinkLoop(first, io, limits);
    expect(calls).toHaveLength(2);
    expect(out.end).toBe('max_usd');
  });
});

describe('think-first loop session: bounded thinking', () => {
  it('caps the think step at thinkTurns, then asks for the analysis from what was read', async () => {
    const { io, calls } = fakeIO(
      [
        { say: 'still reading', end: 'max_turns_per_cycle' },
        { say: 'ANALYSIS now' },
        { say: 'done' },
      ],
      [pass('t')],
    );
    const out = await runThinkLoop(first, io, limits);
    expect(calls[0]?.seg.maxTurns).toBe(8);
    expect(calls.map((c) => c.chain)).toEqual(['think', 'think', 'work']);
    expect(text(calls[1]?.seg.first)).toBe(DECIDE_PROMPT);
    expect(calls[1]?.seg.maxTurns).toBe(1);
    // Execution runs without a think cap.
    expect(calls[2]?.seg.maxTurns).toBeUndefined();
    expect(out.analysis).toBe('ANALYSIS now');
  });

  it('passes the worker conversation, unchanged, into the end review', async () => {
    let seen: readonly Message[] | undefined;
    const { io } = fakeIO([{ say: 'the analysis' }, { say: 'shipped' }], [pass('t1')]);
    io.review = (_analysis, messages) => {
      seen = messages;
      return Promise.resolve(undefined);
    };
    await runThinkLoop(first, io, limits);
    expect(seen?.map((m) => text(m)).join('\n')).toContain('Work on M1.T01');
    expect(seen?.map((m) => text(m)).join('\n')).toContain('the analysis');
    expect(seen?.at(-1)?.role).toBe('assistant');
  });

  it('caps a re-think the same way', async () => {
    const { io, calls } = fakeIO(
      [
        { say: 'a' },
        { say: 'b', end: 'stuck', stuck: { signal: 'no_edit', detail: 'x' } },
        { say: 'c' },
        { say: 'd' },
      ],
      [pass('t')],
    );
    await runThinkLoop(first, io, limits);
    expect(calls[2]?.seg.maxTurns).toBe(8);
  });
});

describe('continueWith', () => {
  it('joins the harness text to a trailing user message so roles keep alternating', () => {
    const toolResult: Message = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok' }],
    };
    const out = continueWith([first, { role: 'assistant', content: [] }, toolResult], 'go on');
    expect(out.history).toHaveLength(2);
    expect(out.first.content).toHaveLength(2);
    expect(continueWith([first, { role: 'assistant', content: [] }], 'go on').history).toHaveLength(
      2,
    );
  });
});
