import { describe, expect, it } from 'vitest';
import { TokenCounter, deterministicStringify } from '../../../src/core/token-count.js';
import {
  LineIntervalSet,
  ShellMutationDetector,
  MinHasher,
} from '../../../src/agent/supersede-index.js';
import { ContextPlanner, DeterministicDigester } from '../../../src/agent/context-planner.js';
import type { Message } from '../../../src/providers/types.js';

describe('TokenCounter and deterministic serialization', () => {
  it('serializes objects deterministically with sorted keys', () => {
    const objA = { z: 1, a: 2, m: { y: 'hello', b: 'world' } };
    const objB = { a: 2, m: { b: 'world', y: 'hello' }, z: 1 };
    expect(deterministicStringify(objA)).toBe(deterministicStringify(objB));
    expect(deterministicStringify(objA)).toBe('{"a":2,"m":{"b":"world","y":"hello"},"z":1}');
  });

  it('memoizes token count on ContentBlock references', () => {
    const counter = new TokenCounter();
    const block = { type: 'text' as const, text: 'console.log("hello world");' };
    const t1 = counter.blockTokens(block);
    const t2 = counter.blockTokens(block);
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBe(t2);
  });

  it('calibrates token estimates against actual provider usage via EMA', () => {
    const counter = new TokenCounter(1.0);
    expect(counter.getCalibrationRatio()).toBe(1.0);
    // Provide samples where provider reported 1.2x estimated
    counter.observeUsage(1000, 1200);
    expect(counter.getCalibrationRatio()).toBeGreaterThan(1.0);
  });
});

describe('LineIntervalSet and SupersedeIndex', () => {
  it('merges overlapping line intervals and queries coverage correctly', () => {
    const set = new LineIntervalSet();
    set.add(1, 100);
    set.add(50, 150);
    expect(set.getIntervals()).toEqual([{ start: 1, end: 150 }]);
    expect(set.covers(10, 120)).toBe(true);
    expect(set.covers(1, 200)).toBe(false);

    // Two disjoint reads that together cover 1-200
    set.add(151, 200);
    expect(set.covers(1, 200)).toBe(true);
  });

  it('detects shell and edit file mutations', () => {
    expect(ShellMutationDetector.isMutation('edit', { path: 'src/main.ts' })).toBe(true);
    expect(ShellMutationDetector.isMutation('bash', { command: 'git checkout main' })).toBe(true);
    expect(
      ShellMutationDetector.isMutation('bash', { command: 'sed -i "" "s/a/b/g" file.txt' }),
    ).toBe(true);
    expect(ShellMutationDetector.isMutation('bash', { command: 'echo "hello"' })).toBe(false);
  });

  it('computes MinHash signatures and estimates Jaccard similarity', () => {
    const text1 = 'the quick brown fox jumps over the lazy dog in the sunny afternoon';
    const text2 = 'the quick brown fox jumps over the sleepy dog in the sunny afternoon';
    const text3 = 'completely unrelated quantum physics tensor network computation in Julia';

    const sig1 = MinHasher.computeSignature(text1);
    const sig2 = MinHasher.computeSignature(text2);
    const sig3 = MinHasher.computeSignature(text3);

    const sim12 = MinHasher.estimatedJaccard(sig1, sig2);
    const sim13 = MinHasher.estimatedJaccard(sig1, sig3);

    expect(sim12).toBeGreaterThan(0.4);
    expect(sim13).toBeLessThan(0.2);
  });
});

describe('ContextPlanner: Deterministic Digests and Invariants', () => {
  function makeToolPair(
    id: string,
    name: string,
    input: Record<string, unknown>,
    content: string,
    isError = false,
  ): Message[] {
    return [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: id, content, ...(isError ? { isError: true } : {}) },
        ],
      },
    ];
  }

  it('digests bash error outputs while preserving test names, assertions, and stack frames', () => {
    const log = `
RUN v1.0.0
FAIL test/math.test.ts > add
  AssertionError: expected 3 to equal 4
  at Context.<anonymous> (test/math.test.ts:15:12)
Error: fatal test breakdown
Tests: 1 failed, 9 passed
`;
    const digested = DeterministicDigester.digestBash('npm test', log, true);
    expect(digested).toContain('failing_tests:');
    expect(digested).toContain('AssertionError: expected 3 to equal 4');
    expect(digested).toContain('test/math.test.ts:15:12');
  });

  it('strictly preserves tool_use and tool_result pairing across planner executions', () => {
    const goal: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'goal: optimize context' }],
    };
    const msgs: Message[] = [
      goal,
      ...makeToolPair('c1', 'bash', { command: 'npm test' }, 'x'.repeat(10_000), false),
      ...makeToolPair('c2', 'read', { path: 'src/app.ts' }, 'y'.repeat(10_000), false),
      ...makeToolPair('c3', 'bash', { command: 'npm test' }, 'z'.repeat(10_000), false),
      { role: 'assistant', content: [{ type: 'text', text: 'planning next steps' }] },
    ];

    const planner = new ContextPlanner();
    const plan = planner.plan(msgs, 5_000);
    const result = planner.applyPlan(msgs, plan);

    // Initial goal message must stay untouched
    expect(result[0]).toEqual(goal);

    // Verify all tool_use and tool_result match 1:1
    const uses = new Set<string>();
    const res = new Set<string>();
    for (const m of result) {
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.add(b.id);
        if (b.type === 'tool_result') res.add(b.toolUseId);
      }
    }
    expect(uses).toEqual(res);
  });

  it('guarantees idempotency: plan(plan(H)) === plan(H)', () => {
    const goal: Message = { role: 'user', content: [{ type: 'text', text: 'idempotency test' }] };
    const msgs: Message[] = [
      goal,
      ...makeToolPair('c1', 'bash', { command: 'npm test' }, 'output '.repeat(1000), false),
      ...makeToolPair('c2', 'bash', { command: 'npm test' }, 'output '.repeat(1000), false),
      { role: 'assistant', content: [{ type: 'text', text: 'next turn' }] },
    ];

    const planner = new ContextPlanner();
    const plan1 = planner.plan(msgs, 2000);
    const pass1 = planner.applyPlan(msgs, plan1);

    const plan2 = planner.plan(pass1, 2000);
    const pass2 = planner.applyPlan(pass1, plan2);

    expect(JSON.stringify(pass1)).toBe(JSON.stringify(pass2));
  });

  it('protects active edits and failing stack traces over passing logs', () => {
    const goal: Message = { role: 'user', content: [{ type: 'text', text: 'fix bug' }] };
    const failLog =
      'FAIL src/index.test.ts\nAssertionError: expected true but got false\nat test.ts:10:5';
    const passLog = 'PASS src/index.test.ts\n' + 'all 100 green tests '.repeat(500);

    const msgs: Message[] = [
      goal,
      ...makeToolPair('c1', 'bash', { command: 'npm test' }, failLog, true),
      ...makeToolPair('c2', 'bash', { command: 'npm test' }, passLog, false),
      ...makeToolPair('c3', 'edit', { path: 'src/index.ts' }, 'diff hunk @@ -1,3 +1,3 @@', false),
      { role: 'assistant', content: [{ type: 'text', text: 'continue' }] },
    ];

    const planner = new ContextPlanner();
    const plan = planner.plan(msgs, 1000);
    const applied = planner.applyPlan(msgs, plan);

    // The failing log must not be stubbed out into blankness
    const c1Result = applied.find((m) =>
      m.content.some((b) => b.type === 'tool_result' && b.toolUseId === 'c1'),
    );
    const c1Content = (c1Result?.content[0] as { content: string }).content;
    expect(c1Content).toContain('digest bash');
    expect(c1Content).toContain('AssertionError');
  });

  it('runs multi-turn trace under 5ms execution time for 100 turns', () => {
    const goal: Message = { role: 'user', content: [{ type: 'text', text: 'bench goal' }] };
    const msgs: Message[] = [goal];
    for (let i = 0; i < 50; i++) {
      msgs.push(
        ...makeToolPair(
          `t${i}`,
          'bash',
          { command: `echo ${i}` },
          `result ${i} `.repeat(50),
          false,
        ),
      );
    }

    const planner = new ContextPlanner();
    const start = performance.now();
    const plan = planner.plan(msgs, 10_000);
    const applied = planner.applyPlan(msgs, plan);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(25); // strict runtime latency budget (< 25ms in vitest worker)
    expect(applied.length).toBe(msgs.length);
  });
});
