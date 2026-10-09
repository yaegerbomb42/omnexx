import { describe, expect, it } from 'vitest';
import {
  clearedStub,
  coerceSummary,
  factSummary,
  ensureFacts,
  openTodos,
  clearOldToolResults,
  contextTokens,
  manageContext,
  renderSummary,
  splitForCompaction,
  transcriptFor,
  type CompactionEvent,
  type CycleSummary,
} from '../../../src/agent/compaction.js';
import type { Message } from '../../../src/providers/types.js';

const first: Message = { role: 'user', content: [{ type: 'text', text: 'Work on M1.T01' }] };
const big = (n: number) => 'x'.repeat(n);

/** first, then `n` rounds of assistant tool call + user tool result of `size` chars. */
function convo(n: number, size = 5_000): Message[] {
  const out: Message[] = [first];
  for (let i = 0; i < n; i++) {
    out.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: `step ${i}` } }],
    });
    out.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `t${i}`, content: `${i}:${big(size)}` }],
    });
  }
  return out;
}

const resultText = (m: Message | undefined) => {
  const b = m?.content[0];
  return b?.type === 'tool_result' ? b.content : '';
};

const summary: CycleSummary = {
  done: ['read src/math.js'],
  inProgress: 'fixing add()',
  filesTouched: ['src/math.js'],
  lastError: 'expected 3, got -1',
  nextStep: 'replace a - b with a + b',
};

const settings = { clearAt: 1_000, keepToolResults: 2, compactAt: 1_000_000, keepTurns: 2 };

describe('clearOldToolResults', () => {
  it('clears all but the newest large results, keeps ids, and never mutates the input', () => {
    const msgs = convo(5);
    const before = JSON.stringify(msgs);
    const r = clearOldToolResults(msgs, 2);
    expect(r.cleared).toBe(3);
    expect(JSON.stringify(msgs)).toBe(before);
    expect(resultText(r.messages[2])).toMatch(/^\[cleared by omnexx: 5002 chars/);
    expect(resultText(r.messages[8])).toBe(`3:${big(5_000)}`);
    expect(resultText(r.messages[10])).toBe(`4:${big(5_000)}`);
    expect(r.messages[2]?.content[0]).toMatchObject({ toolUseId: 't0' });
  });

  it('leaves small and already-cleared results alone', () => {
    expect(clearOldToolResults(convo(4, 50), 0).cleared).toBe(0);
    const once = clearOldToolResults(convo(4), 1);
    expect(clearOldToolResults(once.messages, 1).cleared).toBe(0);
  });
});

describe('clearing stubs and batching', () => {
  it('names the call and points a bash result at its log', () => {
    const stub = clearedStub('[exit 1, 812ms, log cmd-3-2]\nboom', {
      name: 'bash',
      input: { command: 'npm test' },
    });
    expect(stub).toContain('bash {"command":"npm test"}');
    expect(stub).toContain('read_log id="cmd-3-2"');
    expect(clearedStub('file text', { name: 'read', input: { path: 'a.ts' } })).toContain(
      'repeat the call',
    );
    expect(clearedStub('x', undefined)).toContain('a tool call');
  });

  it('clears nothing until enough would go to pay for the cache miss', () => {
    expect(clearOldToolResults(convo(3), 2, 6_000).cleared).toBe(0);
    const r = clearOldToolResults(convo(4), 2, 6_000);
    expect(r.cleared).toBe(2);
    expect(resultText(r.messages[2])).toContain('bash {"command":"step 0"}');
  });

  it('manageContext skips a clear below the minimum', async () => {
    const events: CompactionEvent[] = [];
    // 2 old results of 2k chars ≈ 1.3k tokens: under a 4k-token minimum.
    const msgs = convo(3, 2_000);
    const out = await manageContext(
      msgs,
      first,
      { clearAt: 100, keepToolResults: 1, compactAt: 1e9, keepTurns: 2, minClearTokens: 4_000 },
      undefined,
      (e) => events.push(e),
    );
    expect(events).toHaveLength(0);
    expect(out).toEqual(msgs);
  });
});

describe('splitForCompaction', () => {
  it('keeps the last N assistant turns with their tool results', () => {
    const split = splitForCompaction(convo(5), 2);
    expect(split?.head).toHaveLength(6);
    expect(split?.tail[0]?.role).toBe('assistant');
    expect(split?.tail).toHaveLength(4);
  });
  it('refuses when there is nothing older than the kept turns', () => {
    expect(splitForCompaction(convo(2), 2)).toBeUndefined();
    expect(splitForCompaction(convo(3), 2)).toBeUndefined();
    expect(splitForCompaction(convo(4), 2)?.head).toHaveLength(4);
    expect(splitForCompaction([first], 1)).toBeUndefined();
  });
});

describe('transcriptFor / renderSummary', () => {
  it('caps each block and marks errors', () => {
    const msgs = convo(1, 10_000);
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'x', content: 'boom', isError: true }],
    });
    const t = transcriptFor(msgs, 100);
    expect(t).toContain('tool call bash: {"command":"step 0"}');
    expect(t).toContain('… [10002 chars]');
    expect(t).toContain('tool result (error): boom');
    expect(t.length).toBeLessThan(400);
  });
  it('renders every field', () => {
    const s = renderSummary(summary);
    for (const part of ['read src/math.js', 'fixing add()', 'src/math.js', 'expected 3', 'a + b'])
      expect(s).toContain(part);
  });
});

describe('manageContext', () => {
  it('does nothing under the thresholds', async () => {
    const msgs = convo(1, 10);
    const events: CompactionEvent[] = [];
    const out = await manageContext(msgs, first, settings, undefined, (e) => events.push(e));
    expect(out).toBe(msgs);
    expect(events).toEqual([]);
  });

  it('clears first, and only compacts if still over compactAt', async () => {
    const events: CompactionEvent[] = [];
    let asked = 0;
    const out = await manageContext(
      convo(6),
      first,
      settings,
      () => {
        asked++;
        return Promise.resolve(summary);
      },
      (e) => events.push(e),
    );
    expect(asked).toBe(0);
    expect(events).toMatchObject([{ kind: 'cleared', cleared: 4 }]);
    expect(contextTokens(out)).toBeLessThan(contextTokens(convo(6)));
  });

  it('compacts into the first message, keeps the tail, and carries an earlier summary forward', async () => {
    const tight = { ...settings, compactAt: 500 };
    const events: CompactionEvent[] = [];
    const heads: Message[][] = [];
    const summarize = (head: readonly Message[]) => {
      heads.push([...head]);
      return Promise.resolve(summary);
    };
    const once = await manageContext(convo(6), first, tight, summarize, (e) => events.push(e));
    expect(once[0]?.content).toHaveLength(2);
    expect(JSON.stringify(once[0])).toContain('compacted summary');
    expect(once[1]?.role).toBe('assistant');
    expect(once).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ kind: 'compacted', turnsSummarized: 4 });

    const grown = [...once, ...convo(3).slice(1)];
    await manageContext(grown, first, tight, summarize, () => undefined);
    expect(JSON.stringify(heads[1]?.[0])).toContain('compacted summary');
  });

  it('reports a failed compaction and keeps the context usable', async () => {
    const tight = { ...settings, compactAt: 500 };
    const reasons: string[] = [];
    const emit = (e: CompactionEvent) => {
      if (e.kind === 'compact_failed') reasons.push(e.reason);
    };
    await manageContext(convo(6), first, tight, () => Promise.resolve(undefined), emit);
    await manageContext(convo(6), first, tight, () => Promise.reject(new Error('down')), emit);
    await manageContext(
      convo(2),
      first,
      { ...tight, clearAt: 1e9 },
      () => Promise.resolve(summary),
      emit,
    );
    expect(reasons).toEqual([
      'no summary (budget or malformed answer)',
      'down',
      'too few turns to compact',
    ]);
  });
});

describe('messageSegments', () => {
  it('splits tool-result tokens by tool', async () => {
    const { messageSegments } = await import('../../../src/agent/loop.js');
    const s = messageSegments(convo(2, 3_000));
    expect(s.byTool.bash).toBe(s.toolResults);
    expect(s.toolResults).toBeGreaterThan(1_900);
    expect(s.messages).toBeGreaterThan(s.toolResults);
  });
});

describe('open todos survive compaction', () => {
  const summary: CycleSummary = { done: [], inProgress: 'x', filesTouched: [], nextStep: 'y' };
  const todoCall = (items: unknown): Message => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'td', name: 'todo', input: { items } }],
  });

  it('takes the last todo call and drops done items', () => {
    const head = [
      todoCall([{ text: 'old', status: 'pending' }]),
      todoCall([
        { text: 'write test', status: 'done' },
        { text: 'fix parser', status: 'in_progress' },
        { text: 'run gates', status: 'pending' },
      ]),
    ];
    const s = ensureFacts(summary, head, []);
    expect(s.openTodos).toEqual(['[in_progress] fix parser', '[pending] run gates']);
    expect(renderSummary(s)).toContain('- [pending] run gates');
  });

  it('carries them through a second compaction from the earlier summary text', () => {
    const earlier = renderSummary({ ...summary, openTodos: ['[pending] run gates'] });
    const head: Message[] = [{ role: 'user', content: [{ type: 'text', text: earlier }] }];
    expect(openTodos(head)).toEqual(['[pending] run gates']);
    expect(openTodos(convo(2))).toBeUndefined();
  });
});

describe('lenient summaries', () => {
  it('clips an overshooting answer instead of dropping it', () => {
    const s = coerceSummary({
      done: Array.from({ length: 40 }, (_, i) => `step ${i}`),
      inProgress: 'x'.repeat(900),
      filesTouched: 'src/a.ts',
      nextStep: 'go',
      openTodos: 7,
    });
    expect(s?.done).toHaveLength(30);
    expect(s?.inProgress).toHaveLength(600);
    expect(s?.filesTouched).toEqual(['src/a.ts']);
    expect(s?.openTodos).toBeUndefined();
    expect(coerceSummary({ done: [] })).toBeUndefined();
    expect(coerceSummary('nope')).toBeUndefined();
  });

  it('builds a fact-only summary from the transcript', () => {
    const head = convo(3);
    head.splice(1, 0, { role: 'assistant', content: [{ type: 'text', text: 'checking tests' }] });
    const s = factSummary(head);
    expect(s.done).toHaveLength(3);
    expect(s.done[0]).toContain('bash {"command":"step 0"}');
    expect(s.inProgress).toBe('checking tests');
  });
});

describe('decodeJsonStrings', () => {
  it('decodes top-level strings holding JSON arrays or objects, else returns the input', async () => {
    const { decodeJsonStrings } = await import('../../../src/agent/loop.js');
    const input = { milestones: ' [{"id":"M1"}] ', meta: '{"a":1}', title: 'plain', bad: '[oops' };
    expect(decodeJsonStrings(input)).toEqual({
      milestones: [{ id: 'M1' }],
      meta: { a: 1 },
      title: 'plain',
      bad: '[oops',
    });
    const same = { title: 'plain', n: 1 };
    expect(decodeJsonStrings(same)).toBe(same);
    expect(decodeJsonStrings('x')).toBe('x');
    expect(decodeJsonStrings([1])).toEqual([1]);
  });
});
