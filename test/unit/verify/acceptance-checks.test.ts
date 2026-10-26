import { describe, expect, it } from 'vitest';
import {
  buildPreflightChecks,
  deriveAcceptanceContract,
  inferCheckCommand,
  inferGoalChecks,
  preflightSuiteSchema,
  runVerificationLoop,
} from '../../../src/verify/acceptance-checks.js';
import { fileURLToPath } from 'node:url';

const fixtureDir = fileURLToPath(new URL('../../fixtures/verify/contract-app', import.meta.url));

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

describe('acceptance-contract', () => {
  it('derives a contract and passes when every command exits 0', async () => {
    const contract = deriveAcceptanceContract({
      id: 'task-1',
      requirements: [`node ${fixtureDir}/pass.js`],
    });
    expect(contract.commands).toContain(`node ${fixtureDir}/pass.js`);

    const verdict = await runVerificationLoop({ cwd: fixtureDir, contract });
    expect(verdict.pass).toBe(true);
    expect(verdict.attempts).toBe(1);
    expect(verdict.runs[0]?.exitCode).toBe(0);
  });

  it('fails the contract when a command exits non-zero (planted regression)', async () => {
    const contract = deriveAcceptanceContract({
      id: 'task-2',
      requirements: [`node ${fixtureDir}/fail.js`],
    });
    expect(contract.commands).toContain(`node ${fixtureDir}/fail.js`);

    const verdict = await runVerificationLoop({ cwd: fixtureDir, contract, maxAttempts: 2 });
    expect(verdict.pass).toBe(false);
    expect(verdict.attempts).toBe(2);
    expect(verdict.runs[0]?.exitCode).toBe(1);
  });

  it('completion-with-failing-contract rate is zero: never returns pass=true if any command failed', async () => {
    const contract = deriveAcceptanceContract({
      id: 'task-3',
      requirements: [`node ${fixtureDir}/pass.js`, `node ${fixtureDir}/fail.js`],
    });
    expect(contract.commands).toHaveLength(2);

    const verdict = await runVerificationLoop({ cwd: fixtureDir, contract });
    expect(verdict.pass).toBe(false);
    expect(verdict.runs.some((r) => r.exitCode !== 0)).toBe(true);
  });

  it('stops at the first failing command per attempt', async () => {
    const contract = deriveAcceptanceContract({
      id: 'task-4',
      requirements: [`node ${fixtureDir}/fail.js`, `node ${fixtureDir}/pass.js`],
    });
    const verdict = await runVerificationLoop({ cwd: fixtureDir, contract });
    expect(verdict.pass).toBe(false);
    // Only the first (failing) command ran
    expect(verdict.runs).toHaveLength(1);
    expect(verdict.runs[0]?.command).toContain('fail.js');
  });

  it('deduplicates identical commands from criteria and goal checks', () => {
    const contract = deriveAcceptanceContract({
      id: 'task-5',
      requirements: [`node ${fixtureDir}/pass.js`, `node ${fixtureDir}/pass.js`],
    });
    expect(contract.commands).toHaveLength(1);
  });
});
