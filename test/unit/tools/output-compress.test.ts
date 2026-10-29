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

  it('collapses package manager deprecations and notices while keeping real errors untouched', () => {
    const raw = [
      'npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.',
      'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
      'npm notice New major version of npm available! 10.2.0 -> 10.8.2',
      'npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.8.2',
      '12 packages are looking for funding',
      '  run npm fund for details',
      'npm error code ENOENT',
      'npm error syscall open',
    ].join('\n');

    const result = compressOutput(raw);
    expect(result).toContain('[package manager: 6 warning/notice lines collapsed]');
    expect(result).toContain('npm error code ENOENT');
    expect(result).toContain('npm error syscall open');
    expect(result).not.toContain('inflight@1.0.6');
  });

  it('removes git advice tutorial hints from status output', () => {
    const raw = [
      'On branch feat/tool-output-compactor',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      '\tmodified:   src/tools/output-compress.ts',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      '\ttest/new.test.ts',
    ].join('\n');

    const result = compressOutput(raw);
    expect(result).not.toContain('use "git add');
    expect(result).not.toContain('use "git restore');
    expect(result).toContain('modified:   src/tools/output-compress.ts');
    expect(result).toContain('test/new.test.ts');
  });

  it('folds streaming build progress tickers', () => {
    const raw = [
      'vite v5.0.0 building for production...',
      'transforming (1/50) ...',
      'transforming (25/50) ...',
      'transforming (50/50) ...',
      '✓ 50 modules transformed.',
    ].join('\n');

    expect(compressOutput(raw)).toBe(
      [
        'vite v5.0.0 building for production...',
        '[build: 3 progress lines collapsed]',
        '✓ 50 modules transformed.',
      ].join('\n'),
    );
  });

  it('filters out test runner queued lines', () => {
    const raw = [
      ' ❯ |unit| test/unit/tools/output-summary.test.ts [queued]',
      ' ❯ |unit| test/unit/tools/output-summary.test.ts 0/10',
      '✓ |unit| test/unit/tools/output-summary.test.ts (10 tests) 5ms',
    ].join('\n');

    expect(compressOutput(raw)).toBe(
      '✓ |unit| test/unit/tools/output-summary.test.ts (10 tests) 5ms',
    );
  });

  it('collapses excessive blank lines to a single empty line', () => {
    const raw = 'start\n\n\n\nmiddle\n\n\nend\n';
    expect(compressOutput(raw)).toBe('start\n\nmiddle\n\nend');
  });

  it('dramatically compresses noisy test failure output while preserving failure details', () => {
    const rawLines = [
      'npm warn deprecated inflight@1.0.6: This module is not supported',
      'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
      'npm notice Run npm install -g npm to update!',
      ' ❯ |unit| test/a.test.ts [queued]',
      ' ❯ |unit| test/b.test.ts [queued]',
      ' ✓ test/1.test.ts (5 tests) 10ms',
      ' ✓ test/2.test.ts (10 tests) 20ms',
      ' ✓ test/3.test.ts (8 tests) 15ms',
      ' ✓ test/4.test.ts (2 tests) 4ms',
      'FAIL test/failing.test.ts > calculateTotal',
      'AssertionError: expected 42 to equal 100',
      '    at calculateTotal (/repo/src/billing.ts:42:15)',
      '    at /repo/node_modules/vitest/dist/index.js:100:10',
      '    at /repo/node_modules/vitest/dist/runner.js:50:5',
      '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
      'Test Files  1 failed | 4 passed (5)',
      '     Tests  1 failed | 25 passed (26)',
    ];
    const raw = rawLines.join('\n');
    const compressed = compressOutput(raw);
    const compressedLines = compressed.split('\n');

    // Asserts substantial line reduction
    expect(compressedLines.length).toBeLessThan(rawLines.length / 2);
    // Asserts failure and project frame are 100% preserved
    expect(compressed).toContain('AssertionError: expected 42 to equal 100');
    expect(compressed).toContain('at calculateTotal (/repo/src/billing.ts:42:15)');
    expect(compressed).toContain('[3 dependency frames folded]');
    expect(compressed).toContain('[package manager: 3 warning/notice lines collapsed]');
  });
});
