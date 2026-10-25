import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanArtifact } from '../../../src/core/plannerExecutor.js';
import { PlannerExecutor } from '../../../src/core/plannerExecutor.js';

describe('plannerExecutor', () => {
  let executor: PlannerExecutor;
  let tmpDir: string;

  const plan: PlanArtifact = {
    steps: ['step one'],
    risks: ['risk one'],
    fileTargets: ['src/a.ts', 'src/b.ts'],
    acceptanceCriteria: ['criterion one'],
  };

  beforeEach(() => {
    executor = new PlannerExecutor();
  });

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'planner-executor-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a plan artifact', () => {
    expect(() => {
      executor.emitPlan(plan);
    }).not.toThrow();
  });

  it('throws when validating an edit with no active plan', () => {
    expect(() => {
      executor.validateEdit('src/a.ts');
    }).toThrow('no active plan to validate the edit against');
  });

  it('rejects an edit targeting a file outside fileTargets', () => {
    executor.emitPlan(plan);
    expect(() => {
      executor.validateEdit('src/c.ts');
    }).toThrow(/not included in the active plan's fileTargets/);
  });

  it('accepts an edit targeting a file inside fileTargets', () => {
    executor.emitPlan(plan);
    expect(() => {
      executor.validateEdit('src/a.ts');
    }).not.toThrow();
  });

  it('accepts normalized spellings of a target', () => {
    executor.emitPlan(plan);
    const variants = [
      './src/a.ts',
      'src/../src/a.ts',
      'src//a.ts',
      'src/a.ts/',
      join(process.cwd(), 'src/a.ts'),
    ];
    for (const variant of variants) {
      expect(() => {
        executor.validateEdit(variant);
      }).not.toThrow();
    }
  });

  it('fails to emit a second plan before closing the first', () => {
    executor.emitPlan(plan);
    expect(() => {
      executor.emitPlan(plan);
    }).toThrow('a plan is already active; close it before emitting a new one');
  });

  it('allows a new plan after closing the previous one', () => {
    executor.emitPlan(plan);
    executor.closePlan();
    expect(() => {
      executor.emitPlan(plan);
    }).not.toThrow();
  });

  it('throws when validating against a closed plan', () => {
    executor.emitPlan(plan);
    executor.closePlan();
    expect(() => {
      executor.validateEdit('src/a.ts');
    }).toThrow('no active plan to validate the edit against');
  });

  it('allows a plan with no file targets', () => {
    const emptyTargetsPlan: PlanArtifact = { ...plan, fileTargets: [] };
    expect(() => {
      executor.emitPlan(emptyTargetsPlan);
    }).not.toThrow();
    expect(() => {
      executor.validateEdit('src/a.ts');
    }).toThrow(/not included in the active plan's fileTargets/);
  });

  it('keeps plans isolated between instances', () => {
    const other = new PlannerExecutor();
    executor.emitPlan(plan);
    // `other` owns no plan, so it is unaffected by `executor`'s.
    expect(() => {
      other.validateEdit('src/a.ts');
    }).toThrow('no active plan to validate the edit against');
    other.emitPlan({ ...plan, fileTargets: ['src/x.ts'] });
    other.closePlan();
    // Closing `other` must not close `executor`.
    expect(() => {
      executor.validateEdit('src/a.ts');
    }).not.toThrow();
  });

  describe('symlink handling', () => {
    let realPath: string;
    let linkPath: string | null;

    beforeEach(() => {
      realPath = join(tmpDir, 'untargeted.ts');
      linkPath = join(tmpDir, 'target-link.ts');
      writeFileSync(realPath, '');
      try {
        symlinkSync(realPath, linkPath, 'file');
      } catch {
        linkPath = null; // symlinks unsupported here (e.g., Windows without privileges)
      }
    });

    it('accepts editing a target through a symlink alias', () => {
      if (linkPath === null) {
        return;
      }
      executor.emitPlan({ ...plan, fileTargets: [realPath] });
      expect(() => {
        executor.validateEdit(linkPath as string);
      }).not.toThrow();
    });

    it('accepts editing the direct path of a symlinked target', () => {
      if (linkPath === null) {
        return;
      }
      executor.emitPlan({ ...plan, fileTargets: [linkPath] });
      expect(() => {
        executor.validateEdit(realPath);
      }).not.toThrow();
    });

    it('rejects editing an unrelated file next to symlinked targets', () => {
      if (linkPath === null) {
        return;
      }
      executor.emitPlan({ ...plan, fileTargets: [linkPath] });
      expect(() => {
        executor.validateEdit(join(tmpDir, 'other.ts'));
      }).toThrow(/not included in the active plan's fileTargets/);
    });
  });
});
