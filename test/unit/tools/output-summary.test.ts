import { describe, expect, it } from 'vitest';
import { trimOutput } from '../../../src/tools/bash.js';
import { testSummary } from '../../../src/tools/output-summary.js';

describe('testSummary: the outcome of a test run in one line', () => {
  it.each([
    [
      'vitest',
      ' Test Files  3 passed (3)\n      Tests  40 passed | 2 failed (42)',
      '40 passed, 2 failed',
    ],
    ['vitest all green', '      Tests  12 passed (12)', '12 passed'],
    ['jest', 'Tests:       2 failed, 40 passed, 42 total', '40 passed, 2 failed'],
    [
      'pytest',
      '==== 2 failed, 42 passed, 1 skipped in 1.23s ====',
      '42 passed, 2 failed, 1 skipped',
    ],
    ['node:test', '# tests 42\n# pass 40\n# fail 2', '40 passed, 2 failed'],
    ['mocha', '  40 passing (2s)\n  2 failing', '40 passed, 2 failed'],
    ['cargo', 'test result: FAILED. 40 passed; 2 failed; 0 ignored', '40 passed, 2 failed'],
  ])('%s', (_name, output, expected) => {
    expect(testSummary(output)).toBe(expected);
  });

  it('says nothing for output that is not a test run', () => {
    expect(testSummary('compiled 12 files\ndone')).toBeUndefined();
  });
});

describe('trimOutput: lean by default', () => {
  it('leads with the test outcome and stays under the character cap', () => {
    const lines = [
      ...Array.from({ length: 3_000 }, (_, i) => `noise line ${i} ${'x'.repeat(200)}`),
      'Error: expected 3 to be 4 at test_auth.py:88',
      ...Array.from({ length: 3_000 }, (_, i) => `more ${i}`),
      '      Tests  40 passed | 2 failed (42)',
    ];
    const out = trimOutput(lines.join('\n'), 'cmd-1');
    expect(out.split('\n')[0]).toBe('tests: 40 passed, 2 failed');
    expect(out).toContain('Error: expected 3 to be 4 at test_auth.py:88');
    expect(out).toContain('read_log id="cmd-1"');
    expect(out.length).toBeLessThanOrEqual(12_500);
  });

  it('leaves short output alone', () => {
    expect(trimOutput('a\nb', 'x')).toBe('a\nb');
  });
});
