import { describe, expect, it } from 'vitest';
import type { Baseline } from '../../../src/core/run-store.js';
import { antiCheat } from '../../../src/verify/anticheat.js';
import { toBaseline, type GateResult } from '../../../src/verify/gates.js';
import { failureSignature, judgeGate } from '../../../src/verify/ratchet.js';

const result = (over: Partial<GateResult> = {}): GateResult => ({
  name: 'test',
  level: 'ratchet',
  exitCode: 1,
  timedOut: false,
  durationMs: 1,
  failures: [],
  structured: true,
  logFile: 'x',
  ...over,
});
const fails = (...ids: string[]) => ids.map((id) => ({ id, message: 'm' }));

describe('ratchet', () => {
  const baseline: Baseline = toBaseline([
    result({ failures: fails('old'), tests: { total: 3, passed: 2, failed: 1, skipped: 0 } }),
  ]);

  it('accepts a cycle that fixes the target but leaves a pre-existing failure', () => {
    const v = judgeGate(result({ failures: fails('old') }), baseline);
    expect(v).toMatchObject({ pass: true, newFailures: [], fixed: [] });
  });
  it('rejects any new failure, even when count is equal', () => {
    expect(judgeGate(result({ failures: fails('new') }), baseline)).toMatchObject({
      pass: false,
      newFailures: ['new'],
      fixed: ['old'],
    });
  });
  it('rejects a rising count of the same id', () => {
    expect(judgeGate(result({ failures: fails('old', 'old') }), baseline).reason).toMatch(
      /rose from 1 to 2/,
    );
  });
  it('rejects timeouts and a failing exit where baseline was green', () => {
    expect(judgeGate(result({ timedOut: true }), baseline).reason).toBe('timed out');
    const green = toBaseline([result({ exitCode: 0 })]);
    expect(judgeGate(result({ exitCode: 1 }), green).reason).toMatch(/passed at baseline/);
  });
  it('must-pass and gates missing from the baseline need exit 0', () => {
    expect(judgeGate(result({ level: 'must-pass', failures: fails('old') }), baseline).pass).toBe(
      false,
    );
    expect(judgeGate(result({ name: 'lint', exitCode: 0 }), baseline).pass).toBe(true);
    expect(judgeGate(result({ name: 'lint' }), undefined).pass).toBe(false);
  });
  it('failure signatures ignore line numbers, durations and hashes', () => {
    expect(failureSignature(['a.ts:12:3 failed in 34ms at 0xdeadbeef', 'z'])).toBe(
      failureSignature(['z', 'a.ts:99:1 failed in 1.5s at 0xabc']),
    );
    expect(failureSignature(['commit abcdef1234'])).toBe(failureSignature(['commit 9999999aaaa']));
  });
});

describe('anti-cheat', () => {
  const base = {
    protectedPatterns: ['omnexx.toml', '.github/**', 'package-lock.json'],
    allow: [],
    baseline: undefined,
    results: [],
  };
  const patch = (file: string, ...added: string[]) =>
    `+++ b/${file}\n${added.map((a) => `+${a}`).join('\n')}\n`;

  it('flags deleted tests, renamed-away tests and test-count drops', () => {
    const v = antiCheat({
      ...base,
      changes: [
        { status: 'D', path: 'test/a.test.js', added: 0, removed: 5 },
        { status: 'R', oldPath: 'src/b.spec.ts', path: 'src/b.ts', added: 0, removed: 0 },
        { status: 'D', path: 'src/util.ts', added: 0, removed: 3 },
      ],
      patch: '',
      baseline: toBaseline([result({ tests: { total: 10, passed: 10, failed: 0, skipped: 0 } })]),
      results: [result({ tests: { total: 8, passed: 8, failed: 0, skipped: 0 } })],
    });
    expect(v.map((x) => x.rule)).toEqual(['deleted-test', 'deleted-test', 'test-count-drop']);
  });

  it.each([
    "it.skip('x', () => {})",
    "test.only('x', () => {})",
    "describe.skip('s')",
    "xit('x')",
    "test('x', { skip: true }, () => {})",
    '@pytest.mark.skip(reason="later")',
    '// @ts-ignore',
    '/* eslint-disable no-console */',
    'x = 1  # type: ignore',
    't.Skip("flaky")',
  ])('flags an added marker: %s', (line) => {
    const v = antiCheat({ ...base, changes: [], patch: patch('src/a.test.ts', line) });
    expect(v.map((x) => x.rule)).toEqual(['skip-marker']);
    expect(v[0]?.detail).toContain('src/a.test.ts');
  });

  it('ignores removed and context lines, and markers inside words', () => {
    expect(
      antiCheat({
        ...base,
        changes: [],
        patch: "+++ b/a.ts\n-it.skip('x')\n it.only('y')\n+const skipper = 1;\n",
      }),
    ).toEqual([]);
  });

  it('flags snapshot rewrites and protected paths (including rename sources)', () => {
    const v = antiCheat({
      ...base,
      changes: [
        { status: 'M', path: 'src/__snapshots__/a.test.ts.snap', added: 1, removed: 1 },
        { status: 'A', path: 'src/__snapshots__/new.snap', added: 1, removed: 0 },
        { status: 'M', path: '.github/workflows/ci.yml', added: 1, removed: 0 },
        { status: 'R', oldPath: 'omnexx.toml', path: 'x.toml', added: 0, removed: 0 },
      ],
      patch: '',
    });
    expect(v.map((x) => x.rule)).toEqual(['snapshot-rewrite', 'protected-path', 'protected-path']);
  });

  it('task allow list lifts each rule', () => {
    const v = antiCheat({
      ...base,
      allow: ['delete-tests', 'skip', 'snapshots', 'protected'],
      changes: [
        { status: 'D', path: 'a.test.js', added: 0, removed: 1 },
        { status: 'M', path: 'a.snap', added: 1, removed: 1 },
        { status: 'M', path: 'package-lock.json', added: 1, removed: 1 },
      ],
      patch: patch('a.test.js', 'it.skip("x")'),
    });
    expect(v).toEqual([]);
  });
});
