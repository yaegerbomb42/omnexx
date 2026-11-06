import { describe, expect, it } from 'vitest';
import { analyzeSourceText, countAssertionsInFiles } from '../../../src/autonomous/ast-analysis.js';
import {
  assertNonDegradationPure,
  checkBloat,
  type RepoHealthVector,
} from '../../../src/autonomous/quality-ratchet.js';
import {
  checkDiffHygiene,
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
