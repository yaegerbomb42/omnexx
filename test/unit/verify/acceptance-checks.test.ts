import { describe, expect, it } from 'vitest';
import {
  buildPreflightChecks,
  preflightSuiteSchema,
} from '../../../src/verify/acceptance-checks.js';

describe('acceptance-checks', () => {
  it('generates preflight checks from task title when no separate requirements given', () => {
    const checks = buildPreflightChecks({ id: 'task-1', title: 'Refactor parser' });
    expect(checks).toEqual([
      { id: 'task-1-check-1', description: 'Verify requirement: Refactor parser' },
    ]);
  });

  it('generates preflight checks for each requirement and satisfies schema', () => {
    const checks = buildPreflightChecks({
      id: 'task-2',
      title: 'Database migration',
      requirements: ['Add column x', 'Backfill null values', 'Add index'],
    });
    expect(checks).toHaveLength(3);
    expect(checks[0]?.id).toBe('task-2-check-1');
    expect(checks[2]?.id).toBe('task-2-check-3');
    const parsed = preflightSuiteSchema.safeParse({ checks });
    expect(parsed.success).toBe(true);
  });
});
