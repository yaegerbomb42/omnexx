import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGateOutput } from '../../../src/verify/parsers/index.js';
import { clip, extractJson, relPath } from '../../../src/verify/parsers/types.js';

const sample = (f: string): string => readFileSync(join('test/fixtures/parsers', f), 'utf8');
const ctx = { gate: 'test', exitCode: 1, cwd: '/repo' };

describe('parsers on recorded output', () => {
  it('vitest json', () => {
    const r = parseGateOutput('vitest', `> npm banner\n${sample('vitest.json')}`, ctx);
    expect(r.structured).toBe(true);
    expect(r.failures.map((f) => f.id)).toEqual(['a.test.ts > math fails']);
    expect(r.failures[0]?.message).toContain('expected 2 to be 3');
    expect(r.failures[0]?.message).not.toContain('node_modules');
    expect(r.tests).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
  });

  it('jest json, including a suite that failed to load', () => {
    const r = parseGateOutput('jest', sample('jest.json'), ctx);
    expect(r.failures.map((f) => f.id)).toEqual([
      'src/cart.test.js > cart totals',
      'src/broken.test.js > (file failed to run)',
    ]);
    expect(r.failures[0]?.location).toBe('src/cart.test.js:8');
    expect(r.tests).toEqual({ total: 4, passed: 2, failed: 1, skipped: 1 });
  });

  it('node --test TAP: leaf failures only, suite path in the id', () => {
    const r = parseGateOutput('node-test', sample('node-test.tap'), ctx);
    expect(r.failures.map((f) => f.id)).toEqual([
      'c.test.mjs > suite > fails here',
      'c.test.mjs > top level fail',
    ]);
    expect(r.failures[0]?.message).toContain('1 !== 2');
    expect(r.failures[1]?.message).toBe('boom');
    expect(r.tests).toEqual({ total: 4, passed: 1, failed: 2, skipped: 1 });
  });

  it('tsc', () => {
    const r = parseGateOutput('tsc', sample('tsc.txt'), { ...ctx, exitCode: 2 });
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toMatchObject({
      id: "b.ts:TS2322:Type 'string' is not assignable to type 'number'.",
      location: 'b.ts:1:7',
    });
  });

  it('eslint json and stylish agree', () => {
    const json = parseGateOutput('eslint', sample('eslint.json'), ctx);
    const stylish = parseGateOutput('eslint', sample('eslint-stylish.txt'), ctx);
    expect(json.failures.map((f) => f.id)).toEqual(['d.mjs:no-unused-vars', 'd.mjs:no-debugger']);
    expect(stylish.failures.map((f) => f.id)).toEqual(json.failures.map((f) => f.id));
  });

  it('pytest', () => {
    const r = parseGateOutput('pytest', sample('pytest.txt'), ctx);
    expect(r.failures).toEqual([
      {
        id: 'tests/test_math.py::test_add',
        location: 'tests/test_math.py',
        message: 'assert 2 == 3',
      },
    ]);
    expect(r.tests).toEqual({ total: 4, passed: 2, failed: 1, skipped: 1 });
  });

  it('go test -json', () => {
    const r = parseGateOutput('gotest', sample('gotest.jsonl'), ctx);
    expect(r.failures).toEqual([
      { id: 'example.com/m.TestAdd', message: 'math_test.go:9: add(1,1) = 2, want 3' },
    ]);
    expect(r.tests).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
  });
});

describe('fallbacks', () => {
  it('unparseable output falls back to generic exit-code failure', () => {
    for (const p of ['vitest', 'node-test', 'tsc', 'eslint', 'pytest', 'gotest'] as const) {
      const r = parseGateOutput(p, 'Segmentation fault\nsomething Error happened', ctx);
      expect(r.structured, p).toBe(false);
      expect(r.failures[0]?.id).toBe('test:exit');
    }
  });
  it('generic: passing exit is no failure; message prefers error lines', () => {
    expect(parseGateOutput('generic', 'ok', { ...ctx, exitCode: 0 }).failures).toEqual([]);
    expect(parseGateOutput('generic', 'a\nError: x\nb', ctx).failures[0]?.message).toBe('Error: x');
    expect(parseGateOutput('generic', '', ctx).failures[0]?.message).toBe('exit code 1');
    expect(parseGateOutput('tsc', '', { ...ctx, exitCode: 0 }).failures).toEqual([]);
  });
  it('helpers', () => {
    expect(clip('a\nb\nc', 2)).toBe('a\nb\n… (1 more lines)');
    expect(relPath('file:///private/repo/x.ts', '/repo')).toBe('x.ts');
    expect(relPath('/elsewhere/x.ts', '/repo')).toBe('/elsewhere/x.ts');
    expect(extractJson('no json', '{')).toBeUndefined();
    expect(extractJson('x {bad} {"a":1}', '{')).toEqual({ a: 1 });
    expect(extractJson('x [1] y', '[')).toEqual([1]);
  });
});
