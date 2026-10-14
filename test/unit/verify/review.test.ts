import { describe, expect, it } from 'vitest';
import type { Run } from '../../../src/core/run.js';
import { auditResult, coerceReview } from '../../../src/verify/review.js';

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
      config: { review: { audit_models: 'planner' } },
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
