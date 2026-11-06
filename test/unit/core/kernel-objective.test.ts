import { describe, expect, it } from 'vitest';
import { kernelObjectiveFor } from '../../../src/core/cycle.js';

describe('kernelObjectiveFor', () => {
  it('drops the task id and uses the goal for generic fast-path titles', () => {
    const q = kernelObjectiveFor('Do the whole goal in one pass', 'Fix the bugs in src/math.js');
    expect(q).toBe('Fix the bugs in src/math.js');
    expect(q).not.toMatch(/M1/);
  });
  it('keeps a specific title and appends the goal', () => {
    expect(kernelObjectiveFor('Add retry to fetch client', 'goal')).toBe(
      'Add retry to fetch client\ngoal',
    );
  });
});
