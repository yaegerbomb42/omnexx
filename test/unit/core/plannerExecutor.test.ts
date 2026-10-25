import { describe, expect, it } from 'vitest';
import { closePlan, emitPlan, validateEdit } from '../../../src/core/plannerExecutor.js';

describe('plannerExecutor', () => {
  const plan = {
    steps: ['step one'],
    risks: ['risk one'],
    fileTargets: ['src/a.ts', 'src/b.ts'],
    acceptanceCriteria: ['criterion one'],
  };

  it('accepts a plan artifact', () => {
    closePlan();
    expect(() => {
      emitPlan(plan);
    }).not.toThrow();
  });

  it('rejects an edit targeting a file outside fileTargets', () => {
    closePlan();
    emitPlan(plan);
    expect(() => {
      validateEdit('src/c.ts');
    }).toThrow();
  });

  it('accepts an edit targeting a file inside fileTargets', () => {
    closePlan();
    emitPlan(plan);
    expect(() => {
      validateEdit('src/a.ts');
    }).not.toThrow();
  });

  it('fails to emit a second plan before closing the first', () => {
    closePlan();
    emitPlan(plan);
    expect(() => {
      emitPlan(plan);
    }).toThrow();
  });

  it('allows a new plan after closing the previous one', () => {
    closePlan();
    emitPlan(plan);
    closePlan();
    expect(() => {
      emitPlan(plan);
    }).not.toThrow();
  });
});
