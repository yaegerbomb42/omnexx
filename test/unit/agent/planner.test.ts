import { describe, expect, it } from 'vitest';
import { taskEffortBrief } from '../../../src/agent/planner.js';

describe('planner taskEffortBrief', () => {
  it('maps every effort level to a concise brief', () => {
    expect(taskEffortBrief('trivial')).toBe('~5 min');
    expect(taskEffortBrief('small')).toBe('~30 min');
    expect(taskEffortBrief('medium')).toBe('~1 hr');
    expect(taskEffortBrief('large')).toBe('~2 hr');
    expect(taskEffortBrief('huge')).toBe('~1 day');
  });

  it('falls back for unknown input', () => {
    expect(taskEffortBrief('unknown')).toBe('~1 hr');
    expect(taskEffortBrief(undefined)).toBe('~1 hr');
  });
});
