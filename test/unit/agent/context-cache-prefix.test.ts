import { describe, expect, it } from 'vitest';
import { buildCycleContext } from '../../../src/agent/context.js';
import { pinPrefix } from '../../../src/providers/cache-pinning.js';
import { toChatMessages } from '../../../src/providers/openai-compat.js';
import { applyPlanUpdate, getNode } from '../../../src/core/plan.js';

function mockPlan() {
  const plan = applyPlanUpdate(
    undefined,
    { milestones: [{ id: 'M1', title: 'Mile', tasks: [{ id: 'M1.T01', title: 'Task one' }] }] },
    'g',
  );
  return { plan, task: getNode(plan, 'M1.T01') };
}

function fullInputs(clock: string) {
  const { plan, task } = mockPlan();
  return {
    systemPrompt: 'Core agent prompt',
    codemap: '# Codebase map\nsrc/a.ts',
    goal: 'GOAL-TEXT ship the feature',
    brief: 'SETTINGS-TEXT effort 5',
    clock,
    facts: 'FACTS-TEXT npm test passes',
    notes: 'NOTE-TEXT remember the build',
    plan,
    task,
    progressTail: '',
    evidence: [],
    tools: [],
  };
}

describe('context cache prefix (stable marking)', () => {
  it('marks only the clock volatile and puts the breakpoint on the last stable block', () => {
    const ctx = buildCycleContext(fullInputs('# Clock\n\nElapsed 1.0m of 8h'));
    expect(ctx.labels).toEqual([
      'system',
      'codemap',
      'goal',
      'settings',
      'clock',
      'facts',
      'notes',
    ]);
    expect(ctx.system.map((b) => b.volatile ?? false)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    const breakpoints = ctx.system.map((b) => b.cacheBreakpoint ?? false);
    expect(breakpoints).toEqual([false, false, false, false, false, false, true]);
    expect(ctx.system[4]?.text).toContain('# Clock');
  });

  it('without a clock, the breakpoint stays on the last block and nothing is volatile', () => {
    const { plan, task } = mockPlan();
    const ctx = buildCycleContext({
      systemPrompt: 'Core agent prompt',
      codemap: 'map',
      goal: 'g',
      notes: 'n',
      plan,
      task,
      progressTail: '',
      evidence: [],
      tools: [],
    });
    expect(ctx.system.some((b) => b.volatile)).toBe(false);
    expect(ctx.system.at(-1)?.cacheBreakpoint).toBe(true);
  });

  it('prefixHash is stable across clock ticks and moves when stable content moves', () => {
    const a = buildCycleContext(fullInputs('# Clock\n\nElapsed 1.0m of 8h'));
    const b = buildCycleContext(fullInputs('# Clock\n\nElapsed 2.0m of 8h · pace: tight'));
    expect(b.prefixHash).toBe(a.prefixHash);
    const c = buildCycleContext({
      ...fullInputs('# Clock\n\nElapsed 1.0m of 8h'),
      goal: 'OTHER-GOAL',
    });
    expect(c.prefixHash).not.toBe(a.prefixHash);
  });

  it('pinPrefix strips a stale breakpoint from a volatile block', () => {
    const pinned = pinPrefix([
      { text: 'stable one', volatile: false },
      { text: 'stable two', volatile: false },
      { text: 'clock tick', volatile: true, cacheBreakpoint: true },
    ]);
    expect(pinned.map((b) => b.text)).toEqual(['stable one', 'stable two', 'clock tick']);
    expect(pinned[1]?.cacheBreakpoint).toBe(true);
    expect(pinned[2]?.cacheBreakpoint).toBeUndefined();
    expect(pinned[2]?.volatile).toBe(true);
  });

  it('OpenAI path keeps stable blocks in the system message and carries only the clock', () => {
    const ctx = buildCycleContext(fullInputs('# Clock\n\nCLOCK-TEXT elapsed'));
    const out = toChatMessages({
      model: 'm',
      system: ctx.system,
      messages: [ctx.first],
      tools: [],
      maxTokens: 100,
      messageBreakpoints: [0],
    });
    const textOf = (content: unknown): string => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content
        .map((p) => {
          if (typeof p !== 'object' || p === null || !('text' in p)) return '';
          const t = (p as { text: unknown }).text;
          return typeof t === 'string' ? t : '';
        })
        .join('\n');
    };
    expect(out[0]?.role).toBe('system');
    const systemText = textOf(out[0]?.content);
    expect(systemText).toContain('GOAL-TEXT');
    expect(systemText).toContain('NOTE-TEXT');
    expect(systemText).not.toContain('CLOCK-TEXT');
    const userText = out
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n');
    expect(userText).toContain('CLOCK-TEXT');
  });
});

describe('slot 7 tail clamp (newest wins)', () => {
  it('keeps the newest progress and running context when slot 7 overflows, dropping the oldest', () => {
    const { plan, task } = mockPlan();
    const progressTail = Array.from(
      { length: 50 },
      (_, i) => `## Cycle ${i + 1}\nENTRY-${i + 1} ${'x'.repeat(200)}`,
    ).join('\n\n');
    const runningContext = `older running note\n${'y'.repeat(1500)}\nNEWEST-RUNNING`;
    const ctx = buildCycleContext({
      systemPrompt: 'Core agent prompt',
      codemap: 'map',
      goal: 'g',
      notes: '',
      plan,
      task,
      progressTail,
      evidence: [],
      runningContext,
      tools: [],
    });
    const text = JSON.stringify(ctx.first);
    expect(text).toContain('oldest dropped');
    expect(text).toContain('NEWEST-RUNNING');
    expect(text).toContain('ENTRY-50 ');
    expect(text).not.toContain('ENTRY-1 ');
  });

  it('leaves a fitting slot 7 untouched (no marker, everything present)', () => {
    const { plan, task } = mockPlan();
    const ctx = buildCycleContext({
      systemPrompt: 'Core agent prompt',
      codemap: 'map',
      goal: 'g',
      notes: '',
      plan,
      task,
      progressTail: '## Cycle 1\nsmall progress',
      evidence: [],
      runningContext: 'small running note',
      tools: [],
    });
    const text = JSON.stringify(ctx.first);
    expect(text).not.toContain('oldest dropped');
    expect(text).toContain('small progress');
    expect(text).toContain('small running note');
  });
});
