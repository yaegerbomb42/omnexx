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

  it('infers shell check command when criteria is a clear negative grep pattern', () => {
    const checks = buildPreflightChecks({
      id: 'task-3',
      title: 'Rename API',
      requirements: ['No file other than `src/usr.js` mentions `getUsr`'],
    });
    expect(checks[0]?.command).toBe('! grep -rn "getUsr" --exclude="src/usr.js" src/ test/');
    const parsed = preflightSuiteSchema.safeParse({ checks });
    expect(parsed.success).toBe(true);
  });
});
