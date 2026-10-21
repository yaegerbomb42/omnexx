import { describe, expect, it } from 'vitest';
import {
  buildPreflightChecks,
  inferCheckCommand,
  inferGoalChecks,
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

  it('infers command passes and export checks from goal and criteria', () => {
    expect(inferCheckCommand('`npm run typecheck` passes with zero errors')).toBe(
      'npm run typecheck',
    );
    const goal =
      'Add validation that throws a `ValidationError` (export the class from `src/orders.js`)';
    const checks = inferGoalChecks(goal);
    expect(checks).toContain(
      'node --input-type=module -e \'import { ValidationError } from "./src/orders.js"\'',
    );
  });
});
