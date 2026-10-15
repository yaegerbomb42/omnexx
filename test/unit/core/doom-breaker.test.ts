import { describe, expect, it } from 'vitest';
import type { LoopResult } from '../../../src/agent/loop.js';
import type { Message } from '../../../src/providers/types.js';
import {
  bestNode,
  checkTrip,
  compareScore,
  failKey,
  tombstone,
  TOMBSTONE_CHARS,
  type PassState,
  type StateNode,
} from '../../../src/core/doom-breaker.js';
import {
  runThinkLoop,
  type CheckOutcome,
  type Segment,
  type SessionIO,
} from '../../../src/core/think-loop.js';

const node = (tree: string, s: Partial<PassState> & { pass?: boolean }, i = 0): StateNode => {
  const failIds = s.failIds ?? [];
  return {
    passed: s.passed ?? 0,
    failingChecks: s.failingChecks ?? (failIds.length ? 1 : 0),
    failIds,
    diagnostics: 0,
    diffSize: s.diffSize ?? 10,
    tree,
    pass: s.pass ?? false,
    messageCount: i,
    summary: `tried ${tree}`,
    key: failKey(failIds),
  };
};

describe('doom-loop breaker', () => {
  it('scores by passing tests, then fewer failing checks, then a smaller diff', () => {
    const base = { failIds: [], diagnostics: 0 };
    expect(
      compareScore(
        { ...base, passed: 5, failingChecks: 2, diffSize: 99 },
        { ...base, passed: 4, failingChecks: 0, diffSize: 1 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareScore(
        { ...base, passed: 5, failingChecks: 1, diffSize: 99 },
        { ...base, passed: 5, failingChecks: 2, diffSize: 1 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareScore(
        { ...base, passed: 5, failingChecks: 1, diffSize: 3 },
        { ...base, passed: 5, failingChecks: 1, diffSize: 9 },
      ),
    ).toBeGreaterThan(0);
  });

  it('trips when two consecutive passes lower the score, rewinding to the best node', () => {
    const nodes = [
      node('a', { passed: 8, failIds: ['t1'] }),
      node('b', { passed: 6, failIds: ['t1', 't2'] }),
      node('c', { passed: 4, failIds: ['t1', 't2', 't3'] }),
    ];
    expect(checkTrip(nodes.slice(0, 2))).toBeUndefined();
    const trip = checkTrip(nodes);
    expect(trip?.reason).toBe('score-drop');
    expect(trip?.best.tree).toBe('a');
    expect(trip?.since.map((n) => n.tree)).toEqual(['b', 'c']);
  });

  it('trips on oscillation: a failure set seen before comes back (A broken, then B, then A)', () => {
    const nodes = [
      node('a', { passed: 5, failIds: ['A'] }),
      node('b', { passed: 5, failIds: ['B'], diffSize: 20 }),
      node('c', { passed: 5, failIds: ['A'], diffSize: 30 }),
    ];
    const trip = checkTrip(nodes);
    expect(trip?.reason).toBe('oscillation');
    expect(trip?.best.tree).toBe('a');
  });

  it('leaves an immediate repeat to the existing same-failure re-think', () => {
    const nodes = [
      node('a', { passed: 5, failIds: ['A'] }),
      node('b', { passed: 5, failIds: ['A'] }),
    ];
    expect(checkTrip(nodes)).toBeUndefined();
  });

  it('does not trip when the latest node is the best one, or passed', () => {
    expect(
      checkTrip([
        node('a', { passed: 5, failIds: ['A'] }),
        node('b', { passed: 9, failIds: ['A'] }, 1),
        node('c', { passed: 9, failIds: ['C'] }),
      ]),
    ).toBeUndefined();
    expect(
      checkTrip([node('a', { passed: 5 }), node('b', { passed: 2, pass: true })]),
    ).toBeUndefined();
    expect(bestNode([])).toBeUndefined();
  });

  it('writes a tombstone under ~150 tokens naming what was tried and what broke', () => {
    const nodes = [
      node('a', { passed: 8, failIds: ['t1'] }),
      { ...node('b', { passed: 6, failIds: ['t1', 'x'.repeat(300)] }), summary: 'y'.repeat(2_000) },
      node('c', { passed: 4, failIds: ['t1', 't3'] }),
    ];
    const trip = checkTrip(nodes);
    if (!trip) throw new Error('expected a trip');
    const t = tombstone(trip);
    expect(t.length).toBeLessThanOrEqual(TOMBSTONE_CHARS);
    expect(t).toContain('Rewound 2 pass(es)');
    expect(t).toContain("Don't repeat this approach");
    const short = tombstone({ ...trip, since: [node('c', { passed: 4, failIds: ['t1', 't3'] })] });
    expect(short).toContain('It broke: t3');
    expect(short).toContain('Tried: tried c');
  });
});

const text = (m: Message | undefined): string =>
  (m?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');

const st = (passed: number, failIds: string[]): PassState => ({
  passed,
  failingChecks: failIds.length ? 1 : 0,
  failIds,
  diagnostics: 0,
  diffSize: 10,
});
const red = (tree: string, passed: number, ids: string[]): CheckOutcome => ({
  pass: false,
  failures: `failing: ${ids.join(',')}`,
  signature: ids.join(','),
  tree,
  state: st(passed, ids),
});

function scripted(checks: CheckOutcome[]) {
  const calls: Segment[] = [];
  const restored: string[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let checked = 0;
  const io: SessionIO = {
    segment: (seg) => {
      calls.push(seg);
      const say = `reply ${calls.length}`;
      const out: LoopResult = {
        end: 'done',
        turns: 1,
        finalText: say,
        usage: { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
        usd: 0,
        messages: [
          ...seg.history,
          seg.first,
          { role: 'assistant', content: [{ type: 'text', text: say }] },
        ],
      };
      return Promise.resolve(out);
    },
    check: () => {
      const c = checks[checked++];
      if (!c) throw new Error('no more checks scripted');
      return Promise.resolve(c);
    },
    restore: (tree) => {
      restored.push(tree);
      return Promise.resolve();
    },
    emit: (type, data) => {
      events.push({ type, data });
    },
  };
  return { io, calls, restored, events };
}

const first: Message = { role: 'user', content: [{ type: 'text', text: 'goal' }] };

describe('think loop with the doom-loop breaker', () => {
  it('on oscillation restores the best tree, prunes the turns since into a tombstone, and re-thinks', async () => {
    const { io, calls, restored, events } = scripted([
      red('tA', 5, ['A']),
      red('tB', 5, ['B']),
      red('tA2', 4, ['A']),
      { pass: true, failures: '', signature: '', tree: 'tG', state: st(6, []) },
    ]);
    const out = await runThinkLoop(first, io, {
      rounds: 6,
      rethinks: 2,
      thinkTurns: 4,
      rewinds: 2,
    });
    expect(restored).toEqual(['tA']);
    const rewind = events.find((e) => e.type === 'loop.rewind');
    expect(rewind?.data).toMatchObject({ reason: 'oscillation', tree: 'tA', pruned: 2 });
    // calls: think, execute(tA), fix(tB), fix(tA2), rethink, execute revised
    const rethink = calls[4];
    expect(text(rethink?.first)).toContain('[harness] Rewound 2 pass(es)');
    expect(text(rethink?.first)).toContain('re-think');
    const history = rethink?.history.map(text) ?? [];
    expect(history).toContain('reply 2');
    expect(history).not.toContain('reply 3');
    expect(history).not.toContain('reply 4');
    expect(out).toMatchObject({ green: true, end: 'done' });
  });

  it('trips on two consecutive score drops', async () => {
    const { io, restored, events } = scripted([
      red('t1', 9, ['a']),
      red('t2', 7, ['b']),
      red('t3', 3, ['c']),
      { pass: true, failures: '', signature: '', tree: 'tG', state: st(10, []) },
    ]);
    await runThinkLoop(first, io, { rounds: 6, rethinks: 2, thinkTurns: 4, rewinds: 2 });
    expect(restored).toEqual(['t1']);
    expect(events.find((e) => e.type === 'loop.rewind')?.data).toMatchObject({
      reason: 'score-drop',
    });
  });

  it('bounds rewinds per session, and with none allowed never rewinds', async () => {
    const osc = () => [
      red('tA', 5, ['A']),
      red('tB', 5, ['B']),
      red('tA2', 5, ['A']),
      red('tB2', 5, ['B']),
      red('tA3', 5, ['A']),
      red('tB3', 5, ['B']),
    ];
    const one = scripted(osc());
    await runThinkLoop(first, one.io, { rounds: 6, rethinks: 5, thinkTurns: 4, rewinds: 1 });
    expect(one.events.filter((e) => e.type === 'loop.rewind')).toHaveLength(1);
    const none = scripted(osc());
    await runThinkLoop(first, none.io, { rounds: 6, rethinks: 5, thinkTurns: 4 });
    expect(none.events.filter((e) => e.type === 'loop.rewind')).toHaveLength(0);
    expect(none.restored).toEqual([]);
  });

  it('when re-thinks are spent, the rewind still sends the tombstone with the best tree failures', async () => {
    const { io, calls } = scripted([
      red('tA', 5, ['A']),
      red('tB', 5, ['B']),
      red('tA2', 5, ['A']),
      red('tC', 5, ['C']),
    ]);
    await runThinkLoop(first, io, { rounds: 4, rethinks: 0, thinkTurns: 4, rewinds: 1 });
    expect(text(calls[4]?.first)).toContain('Rewound');
    expect(text(calls[4]?.first)).toContain('failing: A');
  });

  it('reports a fixed failure signature with the agent summary', async () => {
    const fixed: [string, string][] = [];
    const { io } = scripted([
      red('t1', 1, ['x']),
      { pass: true, failures: '', signature: '', tree: 't2' },
    ]);
    await runThinkLoop(
      first,
      {
        ...io,
        onFixed: (sig, summary) => {
          fixed.push([sig, summary]);
          return Promise.resolve();
        },
      },
      { rounds: 4, rethinks: 1, thinkTurns: 4 },
    );
    expect(fixed).toEqual([['x', 'reply 3']]);
  });
});
