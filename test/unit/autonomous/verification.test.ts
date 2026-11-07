import { describe, expect, it } from 'vitest';
import {
  analyzeSourceText,
  countAssertionsInFiles,
  extractExpectations,
  isTestFilePath,
} from '../../../src/autonomous/ast-analysis.js';
import {
  assertNonDegradationPure,
  checkBloat,
  type RepoHealthVector,
} from '../../../src/autonomous/quality-ratchet.js';
import {
  checkDiffHygiene,
  findChangedAssertions,
  gradeCritic,
  SAFETY_DENYLIST,
} from '../../../src/autonomous/verification-pipeline.js';
import {
  FLAKE_REMEDIATION_SCORE,
  FLAKE_REMEDIATION_SEVERITY,
  isTestRelatedToTask,
  testIdFor,
} from '../../../src/autonomous/flake-detector.js';

const vector = (over: Partial<RepoHealthVector> = {}): RepoHealthVector => ({
  tscErrorCount: 0,
  lintErrorCount: 0,
  lintWarningCount: 0,
  passingTestCount: 100,
  totalAssertionCount: 500,
  lineCoveragePct: 85,
  branchCoveragePct: 80,
  maxCyclomaticComplexity: 12,
  testSuiteDurationMs: 10_000,
  ...over,
});

describe('ast-analysis', () => {
  it('counts expect/assert calls, including chained matchers', () => {
    const a = analyzeSourceText(`
      import { expect, it } from 'vitest';
      import assert from 'node:assert';
      it('x', () => {
        expect(1).toBe(1);
        expect(2).toBeGreaterThan(1);
        assert.strictEqual(1, 1);
        assert.ok(true);
      });
    `);
    expect(a.assertionCount).toBe(4);
  });

  it('detects .skip/.only and xit/fit markers', () => {
    expect(analyzeSourceText(`it.skip('x', () => {})`).hasSkipOrOnly).toBe(true);
    expect(analyzeSourceText(`describe.only('x', () => {})`).hasSkipOrOnly).toBe(true);
    expect(analyzeSourceText(`xit('x', () => {})`).hasSkipOrOnly).toBe(true);
    expect(analyzeSourceText(`it('x', () => { expect(1).toBe(1); })`).hasSkipOrOnly).toBe(false);
  });

  it('scores cyclomatic complexity per function', () => {
    const a = analyzeSourceText(`
      export function f(x: number): number {
        if (x > 1) return 1;
        if (x > 2 && x < 5) return 2;
        return x > 3 ? 3 : 4;
      }
      export function g(): number { return 1; }
    `);
    expect(a.maxCyclomaticComplexity).toBe(5); // 1 + if + if + && + ?:
    expect(analyzeSourceText(`export const x = 1;`).maxCyclomaticComplexity).toBe(1);
  });

  it('collects relative imports', () => {
    const a = analyzeSourceText(`
      import { a } from './a.js';
      import { b } from '../b.js';
      import { c } from 'vitest';
    `);
    expect(a.relativeImports).toEqual(['./a.js', '../b.js']);
  });

  it('countAssertionsInFiles returns 0 for missing files', () => {
    expect(countAssertionsInFiles(['/no/such/file.test.ts'])).toBe(0);
  });

  it('recognises test files across JS/TS flavours and spec files', () => {
    for (const f of [
      'test/a.test.ts',
      'test/a.test.tsx',
      'test/a.test.js',
      'test/a.spec.ts',
      'src/a.spec.tsx',
    ]) {
      expect(isTestFilePath(f)).toBe(true);
    }
    for (const f of ['src/a.ts', 'test/a.ts', 'test/helper.ts', 'src/a.test.ts.bak']) {
      expect(isTestFilePath(f)).toBe(false);
    }
  });
});

describe('extractExpectations', () => {
  it('extracts literal expected values with their test title', () => {
    const found = extractExpectations(`
      import { expect, it } from 'vitest';
      import { add } from '../src/adder.js';
      describe('adder', () => {
        it('adds', () => {
          expect(add(2, 3)).toBe(5);
          expect(add(2, 3)).not.toBe(4);
        });
        it('handles negatives', () => {
          expect(add(-1, -2)).toBe(-3);
          expect({ a: 1 }).toEqual({ a: 1 });
        });
      });
    `);
    expect(found).toEqual([
      { testTitle: 'adder › adds', matcher: 'toBe', expected: '5', actual: 'add(2, 3)' },
      { testTitle: 'adder › adds', matcher: 'toBe', expected: '4', actual: 'add(2, 3)' },
      {
        testTitle: 'adder › handles negatives',
        matcher: 'toBe',
        expected: '-3',
        actual: 'add(-1, -2)',
      },
      {
        testTitle: 'adder › handles negatives',
        matcher: 'toEqual',
        expected: '{ a: 1 }',
        actual: '{ a: 1 }',
      },
    ]);
  });

  it('skips non-literal expected values', () => {
    expect(extractExpectations(`it('x', () => { expect(v).toBe(SOME_CONST); });`)).toEqual([]);
  });
});

describe('findChangedAssertions', () => {
  const head = `import { expect, it } from 'vitest';
import { add } from '../src/adder.js';
it('adds', () => {
  expect(add(2, 3)).toBe(5);
  expect(add(0, 0)).toBe(0);
});
`;

  it('flags a changed expected value (the live toBe(5) → toBe(6) case)', () => {
    const changed = findChangedAssertions(
      head,
      head.replace('toBe(5)', 'toBe(6)'),
      'test/adder.test.ts',
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      file: 'test/adder.test.ts',
      testTitle: 'adds',
      matcher: 'toBe',
      before: '5',
      after: '6',
    });
  });

  it('passes identical assertions and ignores added ones', () => {
    expect(findChangedAssertions(head, head, 'test/adder.test.ts')).toEqual([]);
    const added = head.replace('});', `  expect(add(1, 1)).toBe(2);\n});`);
    expect(findChangedAssertions(head, added, 'test/adder.test.ts')).toEqual([]);
  });

  it('flags a removed assertion and a changed asserted expression', () => {
    const removed = head.replace('  expect(add(0, 0)).toBe(0);\n', '');
    const removedChanged = findChangedAssertions(head, removed, 'test/adder.test.ts');
    expect(removedChanged).toHaveLength(1);
    expect(removedChanged[0]).toMatchObject({ before: '0', after: null });

    const actualChanged = findChangedAssertions(
      head,
      head.replace('add(2, 3)', 'add(3, 3)'),
      'test/adder.test.ts',
    );
    expect(actualChanged).toHaveLength(1);
    expect(actualChanged[0]).toMatchObject({ beforeActual: 'add(2, 3)', afterActual: 'add(3, 3)' });
  });
});

describe('checkDiffHygiene (Stage 0)', () => {
  const base = {
    diff: '',
    changedFiles: ['src/foo.ts'],
    readFile: () => undefined,
  };

  it('flags forbidden paths from the denylist', () => {
    for (const file of [
      'omnexx.toml',
      '.omnexx/state.json',
      'CLAUDE.md',
      '.github/workflows/x.yml',
      '.env.local',
      'key.pem',
    ]) {
      const r = checkDiffHygiene({ ...base, changedFiles: [file] });
      expect(r.clean).toBe(false);
      expect(r.violations.join(' ')).toMatch(/forbidden path/);
    }
    expect(SAFETY_DENYLIST).toContain('omnexx.toml');
  });

  it('flags secrets on added lines', () => {
    // Built at runtime so this test file itself never contains a live-looking key.
    const fakeKey = ['sk-ant-', 'a'.repeat(20)].join('');
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      `+const key = "${fakeKey}";`,
    ].join('\n');
    const r = checkDiffHygiene({ ...base, diff });
    expect(r.clean).toBe(false);
    expect(r.violations.join(' ')).toMatch(/Anthropic API Key/);
  });

  it('flags oscillation when a diff restores a replaced blob', () => {
    const sha = 'a'.repeat(40);
    const r = checkDiffHygiene({
      ...base,
      blobShas: new Map([['src/foo.ts', sha]]),
      recentBlobHistory: [sha],
    });
    expect(r.clean).toBe(false);
    expect(r.violations.join(' ')).toMatch(/oscillation/);
  });

  it('rejects added .skip in changed tests and enforces the assertion floor', () => {
    const r = checkDiffHygiene({
      diff: '',
      changedFiles: ['test/unit/foo.test.ts'],
      baselineAssertionCount: 3,
      readFile: () => `it.skip('x', () => { expect(1).toBe(1); });`,
    });
    expect(r.clean).toBe(false);
    expect(r.violations.join(' ')).toMatch(/\.skip/);
    expect(r.violations.join(' ')).toMatch(/assertion count/);
  });

  it('passes a clean diff with assertions at baseline', () => {
    const r = checkDiffHygiene({
      diff: '',
      changedFiles: ['src/foo.ts', 'test/unit/foo.test.ts'],
      baselineAssertionCount: 2,
      readFile: (p) =>
        p.endsWith('.test.ts') ? `it('x', () => { expect(1).toBe(1); expect(2).toBe(2); });` : '',
    });
    expect(r.clean).toBe(true);
    expect(r.assertionCount).toBe(2);
  });

  it('fails the live test-gaming case: test-only diff with toBe(5) → toBe(6)', () => {
    const head = `import { expect, it } from 'vitest';
import { add } from '../src/adder.js';
it('adds', () => {
  expect(add(2, 3)).toBe(5);
});
`;
    const weakened = head.replace('toBe(5)', 'toBe(6)');
    const r = checkDiffHygiene({
      diff: '',
      changedFiles: ['test/adder.test.ts'],
      readFile: () => weakened,
      readHeadFile: () => head,
    });
    expect(r.clean).toBe(false);
    expect(r.violations.join(' ')).toMatch(/weakened test expectation.*toBe.*5 → 6/);
    expect(r.violations.join(' ')).toMatch(/test-only diff/);
  });

  it('passes a genuine fix: expectation changes together with the source under test', () => {
    const head = `import { expect, it } from 'vitest';
import { greet } from '../src/greet.js';
it('greets', () => {
  expect(greet()).toBe('hi');
});
`;
    const r = checkDiffHygiene({
      diff: '',
      changedFiles: ['src/greet.ts', 'test/greet.test.ts'],
      readFile: () => head.replace(`toBe('hi')`, `toBe('hello')`),
      readHeadFile: () => head,
    });
    expect(r.clean).toBe(true);
  });

  it('does not excuse a weakened expectation when only an unrelated source file changed', () => {
    const head = `import { expect, it } from 'vitest';
import { add } from '../src/adder.js';
it('adds', () => {
  expect(add(2, 3)).toBe(5);
});
`;
    const r = checkDiffHygiene({
      diff: '',
      changedFiles: ['src/other.ts', 'test/adder.test.ts'],
      readFile: () => head.replace('toBe(5)', 'toBe(6)'),
      readHeadFile: () => head,
    });
    expect(r.clean).toBe(false);
    expect(r.violations.join(' ')).toMatch(/weakened test expectation/);
  });

  it('passes a test-only diff that only adds tests', () => {
    const head = `import { expect, it } from 'vitest';
it('adds', () => {
  expect(1 + 1).toBe(2);
});
`;
    // New assertion in the existing file, old ones untouched.
    const added = head.replace('});', `  expect(2 + 2).toBe(4);\n});`);
    const existingFile = checkDiffHygiene({
      diff: '',
      changedFiles: ['test/adder.test.ts'],
      readFile: () => added,
      readHeadFile: () => head,
    });
    expect(existingFile.clean).toBe(true);

    // Brand-new test file (no HEAD version).
    const newFile = checkDiffHygiene({
      diff: '',
      changedFiles: ['test/new.test.ts'],
      readFile: () => head,
      readHeadFile: () => undefined,
    });
    expect(newFile.clean).toBe(true);
  });

  it('flags weakened expectations in .spec files too', () => {
    const head = `it('adds', () => { expect(1 + 1).toBe(2); });`;
    const r = checkDiffHygiene({
      diff: '',
      changedFiles: ['test/adder.spec.ts'],
      readFile: () => head.replace('toBe(2)', 'toBe(3)'),
      readHeadFile: () => head,
    });
    expect(r.clean).toBe(false);
    expect(r.violations.join(' ')).toMatch(/weakened test expectation/);
  });
});

describe('gradeCritic (Stage 4)', () => {
  it('accepts an all-4 APPROVE and rejects sub-4 scores', () => {
    expect(
      gradeCritic({
        logic_soundness: 5,
        minimal_diff: 4,
        convention_compliance: 4,
        unintended_side_effects: 5,
        verdict: 'APPROVE',
      }),
    ).toBeDefined();
    expect(
      gradeCritic({
        logic_soundness: 3,
        minimal_diff: 5,
        convention_compliance: 5,
        unintended_side_effects: 5,
        verdict: 'APPROVE',
      }),
    ).toBeUndefined();
    expect(
      gradeCritic({
        logic_soundness: 5,
        minimal_diff: 5,
        convention_compliance: 5,
        unintended_side_effects: 5,
        verdict: 'REJECT',
      }),
    ).toBeDefined();
    expect(gradeCritic({ verdict: 'APPROVE' })).toBeUndefined();
  });
});

describe('assertNonDegradationPure (quality ratchet)', () => {
  it('passes when nothing regresses', () => {
    const r = assertNonDegradationPure(vector(), vector(), [9_000, 10_000, 11_000]);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('fails on any rising error count or falling test/assertion count', () => {
    const r = assertNonDegradationPure(
      vector(),
      vector({ tscErrorCount: 1, passingTestCount: 99 }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.metric)).toEqual(['tscErrorCount', 'passingTestCount']);
  });

  it('allows coverage to dip at most 0.01%', () => {
    expect(assertNonDegradationPure(vector(), vector({ lineCoveragePct: 84.99 })).ok).toBe(true);
    expect(assertNonDegradationPure(vector(), vector({ lineCoveragePct: 84.98 })).ok).toBe(false);
    expect(assertNonDegradationPure(vector(), vector({ branchCoveragePct: 79.99 })).ok).toBe(true);
  });

  it('fires the duration gate only with >= 3 samples and >10% over median', () => {
    const history = [9_000, 10_000, 11_000];
    expect(
      assertNonDegradationPure(vector(), vector({ testSuiteDurationMs: 11_000 }), history).ok,
    ).toBe(true);
    expect(
      assertNonDegradationPure(vector(), vector({ testSuiteDurationMs: 11_001 }), history).ok,
    ).toBe(false);
    const short = assertNonDegradationPure(
      vector(),
      vector({ testSuiteDurationMs: 99_000 }),
      [10_000],
    );
    expect(short.ok).toBe(true);
    expect(short.durationCheckSkipped).toBe(true);
  });

  it('fails when max complexity rises', () => {
    expect(assertNonDegradationPure(vector(), vector({ maxCyclomaticComplexity: 13 })).ok).toBe(
      false,
    );
  });
});

describe('checkBloat', () => {
  it('flags non-coverage tasks over 150 net lines, never coverage tasks', () => {
    expect(checkBloat(200, 10, false).needsHumanReview).toBe(true);
    expect(checkBloat(200, 10, true).needsHumanReview).toBe(false);
    expect(checkBloat(160, 20, false).needsHumanReview).toBe(false);
    expect(checkBloat(151, 0, false).netLoc).toBe(151);
  });
});

describe('flake detector helpers', () => {
  it('formats test ids as file › name', () => {
    expect(testIdFor('test/a.test.ts', 'does x')).toBe('test/a.test.ts › does x');
  });

  it('uses the specified remediation severity and score', () => {
    expect(FLAKE_REMEDIATION_SEVERITY).toBe(1.0);
    expect(FLAKE_REMEDIATION_SCORE).toBe(92.0);
  });

  it('treats a directly touched test file as related', () => {
    expect(isTestRelatedToTask('test/unit/a.test.ts', ['test/unit/a.test.ts'], '/tmp/repo')).toBe(
      true,
    );
    expect(isTestRelatedToTask('test/unit/a.test.ts', ['src/other.ts'], '/tmp/repo')).toBe(false);
  });
});
