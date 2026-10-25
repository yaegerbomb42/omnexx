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
    expect(checks[0]?.command).toBe("! grep -rn 'getUsr' --exclude='src/usr.js' src/ test/");
    const parsed = preflightSuiteSchema.safeParse({ checks });
    expect(parsed.success).toBe(true);
  });

  it('infers command passes and export checks from goal and criteria', () => {
    expect(inferCheckCommand('`npm run typecheck` passes with zero errors')).toBe(
      'npm run typecheck',
    );
    expect(inferCheckCommand('`npm test` passes with tests for quoting and empty values')).toBe(
      "npm test && ! (npm test 2>&1 | grep -q 'ℹ tests 0')",
    );
    const goal =
      'Add validation that throws a `ValidationError` (export the class from `src/orders.js`) with a `field` property naming the first bad field:\n- `customerId`: non-empty string\n- `items`: non-empty array\nAdd `toCsv(rows, columns)` to `src/csv.js` and use it in `src/export.js` so `exportUsers(users)` returns CSV with a header row `id,name,email`.';
    const checks = inferGoalChecks(goal);
    expect(checks).toContain(
      'node --input-type=module -e \'import { ValidationError } from "./src/orders.js"\'',
    );
    expect(checks).toContain(
      'node --input-type=module -e \'import { toCsv } from "./src/csv.js"\'',
    );
    expect(checks).toContain('node --input-type=module -e \'import "./src/export.js"\'');
    expect(checks).toContain(
      'node --input-type=module -e \'import { ValidationError } from "./src/orders.js"; for (const f of ["customerId", "items"]) { const e = new ValidationError(f); if (e.field !== f) process.exit(1); }\'',
    );
    expect(checks).toContain(
      'node --input-type=module -e \'import { exportUsers } from "./src/export.js"; const r = exportUsers([]); if (!r.startsWith("id,name,email")) process.exit(1);\'',
    );
  });
});
