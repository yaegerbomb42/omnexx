import { describe, expect, it } from 'vitest';
import type { PlanNode } from '../../../src/core/plan.js';
import type { Run } from '../../../src/core/run.js';
import { WRITING_REVIEW_SYSTEM } from '../../../src/core/writing.js';
import type { Message, SystemBlock } from '../../../src/providers/types.js';
import {
  AUDIT_SYSTEM,
  REVIEW_SYSTEM,
  auditResult,
  coerceReview,
  reviewChange,
} from '../../../src/verify/review.js';
import { call, ScriptedProvider } from '../../support/scripted-provider.js';

describe('coerceReview', () => {
  it('maps a model’s own field names and severities onto the schema', () => {
    const r = coerceReview({
      summary: 'two gaps',
      findings: [
        { finding: 'CSV export ignores quotes', severity: 'High', path: 'src/csv.js' },
        { issue: 'no tests for empty input', level: 'critical', suggestion: 'add one' },
        { finding: 'function exists', status: 'confirmed' },
        'docs missing',
        { severity: 'major' },
      ],
    });
    expect(r?.findings).toEqual([
      { severity: 'major', file: 'src/csv.js', problem: 'CSV export ignores quotes', fix: '' },
      { severity: 'blocker', file: '', problem: 'no tests for empty input', fix: 'add one' },
      { severity: 'minor', file: '', problem: 'docs missing', fix: '' },
    ]);
    expect(r?.summary).toBe('two gaps');
  });

  it('accepts other list names, caps the list, and rejects unusable answers', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ problem: `gap ${i}`, severity: 'minor' }));
    expect(coerceReview({ gaps: many })?.findings).toHaveLength(20);
    expect(coerceReview({ issues: [] })).toEqual({ findings: [], summary: '' });
    expect(coerceReview({ verdict: 'fine' })).toBeUndefined();
    expect(coerceReview({ findings: [], summary: 'sound' })).toEqual({
      findings: [],
      summary: 'sound',
    });
    expect(coerceReview('nope')).toBeUndefined();
  });
});

describe('auditResult', () => {
  it('asks once more, spelling out the answer shape, when the first answer is unusable', async () => {
    const prompts: string[] = [];
    const answers: unknown[] = [{}, { findings: [] }];
    const run = {
      config: { review: { audit_models: 'planner' }, context: {} },
      redactor: { text: (t: string) => t },
      events: { emit: () => undefined },
      cheapComplete: (req: { messages: { content: { text: string }[] }[] }) => {
        prompts.push(req.messages[0]?.content[0]?.text ?? '');
        return Promise.resolve({
          res: {
            content: [{ type: 'tool_use', id: 'a', name: 'answer', input: answers.shift() }],
            stopReason: 'tool_use',
          },
          model: { provider: 'p', id: 'm' },
        });
      },
    } as unknown as Run;
    const r = await auditResult(run, 'goal', 'intent', 'code');
    expect(r).toMatchObject({ findings: [] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"findings": []');
  });
});

const task = {
  id: 'M1.T01',
  title: 'Add sum',
  why: 'the goal needs it',
  acceptance: ['sum(1, 2) is 3'],
} as PlanNode;

const workerSystem: SystemBlock[] = [
  { text: 'WORKER SYSTEM PREFIX\nexact bytes' },
  { text: '# Codemap\n\nfile.ts — the map', volatile: true, cacheBreakpoint: true },
];

const workerMessages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Work on M1.T01' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'analysis stays here' }] },
];

const userText = (m: Message | undefined): string => {
  const b = m?.content[0];
  return b?.type === 'text' ? b.text : '';
};

function scriptedRun(budget: number | undefined, answers: unknown[], writing = false) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const provider = new ScriptedProvider(() => call('answer', answers.shift() ?? { findings: [] }));
  const run = {
    state: { writing },
    config: {
      review: { review_models: 'worker', audit_models: 'planner', max_diff_chars: 4_000 },
      context: budget === undefined ? {} : { budget_tokens: budget },
    },
    redactor: { text: (t: string) => t },
    events: {
      emit: (type: string, data: Record<string, unknown> = {}) => {
        events.push({ type, data });
      },
    },
    cheapComplete: (req: Parameters<ScriptedProvider['complete']>[0]) =>
      provider
        .complete({ ...req, model: 'scripted', route: 'scripted' })
        .then((res) => ({ res, model: { provider: 'scripted', id: 'scripted' } })),
  } as unknown as Run;
  return { run, provider, events };
}

describe('cached review prefix', () => {
  const worker = { system: workerSystem, messages: workerMessages };

  it('sends the worker system bytes and puts the rubric in the new user turn', async () => {
    const { run, provider, events } = scriptedRun(undefined, [{ findings: [], summary: 'sound' }]);
    const r = await reviewChange(run, task, 'ship sum', 'diff --git a/sum.ts', worker);
    expect(r).toEqual({ findings: [], summary: 'sound' });
    const req = provider.requests[0];
    expect(req?.system).toBe(workerSystem);
    expect(req?.messages.slice(0, -1)).toEqual(workerMessages);
    const text = userText(req?.messages.at(-1));
    expect(text.startsWith(REVIEW_SYSTEM)).toBe(true);
    expect(text).toContain('diff --git a/sum.ts');
    expect(events).toContainEqual({
      type: 'review.cache_path',
      data: { path: 'prefix', task: 'M1.T01' },
    });
  });

  it('falls back to the standalone system prompt when the conversation exceeds the budget', async () => {
    const { run, provider, events } = scriptedRun(1, [{ findings: [], summary: '' }]);
    await reviewChange(run, task, 'ship sum', 'diff --git a/sum.ts', worker);
    const req = provider.requests[0];
    expect(req?.system).toEqual([{ text: REVIEW_SYSTEM }]);
    expect(req?.messages).toHaveLength(1);
    expect(userText(req?.messages[0]).startsWith('# Goal')).toBe(true);
    expect(events[0]).toEqual({
      type: 'review.cache_path',
      data: { path: 'standalone', task: 'M1.T01' },
    });
  });

  it('returns undefined when both review answers are unusable', async () => {
    const { run, provider } = scriptedRun(undefined, [{ verdict: 'fine' }, { nope: true }]);
    const r = await reviewChange(run, task, 'ship sum', 'diff --git a/sum.ts', worker);
    expect(r).toBeUndefined();
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.system).toBe(workerSystem);
    expect(provider.requests[1]?.system).toBe(workerSystem);
    expect(userText(provider.requests[1]?.messages.at(-1))).toContain('"findings": []');
  });

  it('keeps the writing rubric in the user turn, on the worker system blocks', async () => {
    const { run, provider } = scriptedRun(undefined, [{ findings: [] }], true);
    await reviewChange(run, task, 'write chapter 3', 'diff --git a/book/03.md', worker);
    const req = provider.requests[0];
    expect(req?.system).toBe(workerSystem);
    const text = userText(req?.messages.at(-1));
    expect(text.startsWith(WRITING_REVIEW_SYSTEM)).toBe(true);
    expect(text).toContain('diff --git a/book/03.md');
  });

  it('audits on the worker prefix and falls back when that turn is over budget', async () => {
    const fit = scriptedRun(undefined, [{ findings: [], summary: 'done' }]);
    const ok = await auditResult(fit.run, 'goal', 'done when: sums', 'code', worker);
    expect(ok).toEqual({ findings: [], summary: 'done' });
    expect(fit.provider.requests[0]?.system).toBe(workerSystem);
    expect(userText(fit.provider.requests[0]?.messages.at(-1)).startsWith(AUDIT_SYSTEM)).toBe(true);
    expect(fit.events[0]?.data).toEqual({ path: 'prefix' });

    const over = scriptedRun(1, [{ findings: [] }]);
    await auditResult(over.run, 'goal', 'done when: sums', 'code', worker);
    expect(over.provider.requests[0]?.system).toEqual([{ text: AUDIT_SYSTEM }]);
    expect(over.events[0]?.data).toEqual({ path: 'standalone' });
  });
});
