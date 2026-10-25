import { describe, expect, it } from 'vitest';
import { antiCheat } from '../../../src/verify/anticheat.js';

const base = {
  protectedPatterns: ['omnexx.toml', '.github/**', 'package-lock.json'],
  allow: [],
  baseline: undefined,
  results: [],
};
const patch = (file: string, ...added: string[]) =>
  `+++ b/${file}\n${added.map((a) => `+${a}`).join('\n')}\n`;

describe('anticheat: skip markers inside string literals', () => {
  it('ignores describe.skip inside a string literal comment', () => {
    // Exact trigger from spec: a test that documents the banned marker in a string.
    const line = '  expect(src).toContain("describe.skip("); // documents the banned marker';
    const v = antiCheat({ ...base, changes: [], patch: patch('test/x.test.ts', line) });
    expect(v).toEqual([]);
  });

  it('still flags a real describe.skip call', () => {
    const line = "describe.skip('x', () => {";
    const v = antiCheat({ ...base, changes: [], patch: patch('test/x.test.ts', line) });
    expect(v.map((x) => x.rule)).toEqual(['skip-marker']);
    expect(v[0]?.detail).toContain('describe.skip');
  });

  it('ignores it.skip inside a single-quoted string', () => {
    const line = "const markers = ['it.skip', 'test.only'];";
    const v = antiCheat({ ...base, changes: [], patch: patch('test/lint.test.ts', line) });
    expect(v).toEqual([]);
  });

  it('ignores t.skip inside a backtick template literal', () => {
    const line = '`t.skip("reason")`';
    const v = antiCheat({ ...base, changes: [], patch: patch('test/x.test.ts', line) });
    expect(v).toEqual([]);
  });
});
