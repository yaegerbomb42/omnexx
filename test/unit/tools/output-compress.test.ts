import { describe, expect, it } from 'vitest';
import { compressOutput } from '../../../src/tools/output-compress.js';

describe('compressOutput', () => {
  it('strips ANSI colors and keeps only the last frame of a spinner or progress line', () => {
    const raw = '\x1b[32m✓ ok\x1b[39m\nbuilding 10%\rbuilding 50%\rbuilding 100%\ndone\n';
    expect(compressOutput(raw)).toBe('✓ ok\nbuilding 100%\ndone');
  });

  it('collapses passing test lines into one count and keeps failures verbatim', () => {
    const raw = [
      ' ✓ test/a.test.ts (3 tests) 12ms',
      ' ✓ test/b.test.ts (5 tests) 8ms',
      ' ✓ test/c.test.ts (1 test) 2ms',
      ' × test/d.test.ts > adds numbers',
      'PASS src/x.test.js',
      'ok 4 - parses input',
    ].join('\n');
    expect(compressOutput(raw)).toBe(
      ['[✓ 5 passing lines collapsed]', ' × test/d.test.ts > adds numbers'].join('\n'),
    );
  });

  it('folds runs of identical lines but keeps lines that differ, even only by a number', () => {
    const raw = [
      'warn: deprecated foo',
      'warn: deprecated foo',
      'warn: deprecated foo',
      'end',
    ].join('\n');
    expect(compressOutput(raw)).toBe('warn: deprecated foo\n[… 2 more like this]\nend');
    expect(compressOutput('file1.ts\nfile2.ts\nfile3.ts')).toBe('file1.ts\nfile2.ts\nfile3.ts');
  });

  it('folds stack frames from dependencies into one line', () => {
    const raw = [
      'Error: boom',
      '    at parse (/repo/src/parse.ts:10:5)',
      '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
      '    at run (/repo/node_modules/vitest/dist/run.js:1:1)',
      '    at next (/repo/node_modules/vitest/dist/run.js:2:1)',
      '  File "/repo/.venv/lib/python3.12/site-packages/pytest/main.py", line 4, in x',
    ].join('\n');
    expect(compressOutput(raw)).toBe(
      [
        'Error: boom',
        '    at parse (/repo/src/parse.ts:10:5)',
        '    [4 dependency frames folded]',
      ].join('\n'),
    );
  });

  it('leaves ordinary output alone', () => {
    const raw = 'line one\nline two\n';
    expect(compressOutput(raw)).toBe('line one\nline two');
  });
});
