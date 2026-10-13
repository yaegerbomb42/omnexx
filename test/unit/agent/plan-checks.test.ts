import { describe, expect, it } from 'vitest';
import { brokenChecks } from '../../../src/agent/planner.js';

const plan = (title: string) => ({
  milestones: [
    {
      id: 'M1',
      title: 'Fix pagination',
      tasks: [{ id: 'M1.T01', title, checks: ['npm test'] }],
    },
  ],
});

describe('brokenChecks: plans that cannot land', () => {
  it('rejects a task that adds a test meant to fail, telling the planner to merge it', () => {
    for (const t of [
      'Add test verifying correct page items (expected to fail)',
      'Write a failing test first for totalPages',
      'Add tests that fail now for the empty case',
    ]) {
      const out = brokenChecks(plan(t));
      expect(out.join('\n')).toMatch(/meant to fail.*Merge it with the task that fixes the code/);
    }
  });

  it('accepts a task that adds a test and makes it pass', () => {
    const out = brokenChecks(plan('Fix paginate and add a test for totalPages'));
    expect(out.join('\n')).not.toMatch(/meant to fail/);
  });
});
