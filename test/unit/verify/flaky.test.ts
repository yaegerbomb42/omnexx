import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../../../src/core/exec.js';
import { gateSchema } from '../../../src/config/schema.js';
import { runGatesWithFlakyCheck } from '../../../src/verify/flaky.js';

const tap = (fails: string[]) =>
  [
    'TAP version 13',
    ...['a', 'b'].map((n, i) => `${fails.includes(n) ? 'not ok' : 'ok'} ${i + 1} - ${n}`),
    '1..2',
  ].join('\n');

/** An executor that replays the given outputs in order and counts calls. */
function replay(...runs: Partial<ExecResult>[]) {
  let i = 0;
  const exec = () => {
    const r = runs[Math.min(i++, runs.length - 1)] ?? {};
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      output: '',
      durationMs: 1,
      ...r,
    });
  };
  return { exec, calls: () => i };
}

const gate = (o: object = {}) =>
  gateSchema.parse({ name: 'test', run: 'x', parser: 'node-test', ...o });
const ctx = (exec: ReturnType<typeof replay>['exec']) => ({
  exec,
  cwd: '/tmp',
  env: {},
  logsDir: '/tmp',
  label: 'c1',
  maxCmdTimeoutMs: 60_000,
  redact: (s: string) => s,
});
const fail = (ids: string[]) => ({ exitCode: 1, output: tap(ids) });

describe('runGatesWithFlakyCheck', () => {
  it('does not re-run a passing gate', async () => {
    const r = replay({ output: tap([]) });
    const out = await runGatesWithFlakyCheck([gate()], ctx(r.exec), undefined);
    expect(r.calls()).toBe(1);
    expect(out.flaky).toEqual([]);
  });

  it('marks ids that pass on re-run as flaky and judges the last run', async () => {
    const r = replay(fail(['a']), { output: tap([]) });
    const out = await runGatesWithFlakyCheck([gate()], ctx(r.exec), undefined);
    expect(r.calls()).toBe(2);
    expect(out.flaky).toEqual([{ gate: 'test', ids: [expect.stringContaining('a')] }]);
    expect(out.results[0]?.exitCode).toBe(0);
  });

  it('keeps persistent failures, and only reports the ids that recovered', async () => {
    const r = replay(fail(['a', 'b']), fail(['b']));
    const out = await runGatesWithFlakyCheck([gate()], ctx(r.exec), undefined);
    expect(out.flaky[0]?.ids).toHaveLength(1);
    expect(out.results[0]?.failures).toHaveLength(1);
  });

  it('never re-runs a timeout, unparsed output, or a gate with flaky_reruns = 0', async () => {
    for (const [g, run] of [
      [gate(), { exitCode: 1, timedOut: true, output: tap(['a']) }],
      [gate({ parser: 'generic' }), { exitCode: 1, output: 'boom' }],
      [gate({ flaky_reruns: 0 }), fail(['a'])],
    ] as const) {
      const r = replay(run, { output: tap([]) });
      expect((await runGatesWithFlakyCheck([g], ctx(r.exec), undefined)).flaky).toEqual([]);
      expect(r.calls()).toBe(1);
    }
  });

  it('honors more than one re-run', async () => {
    const r = replay(fail(['a']), fail(['a']), { output: tap([]) });
    const out = await runGatesWithFlakyCheck([gate({ flaky_reruns: 2 })], ctx(r.exec), undefined);
    expect(r.calls()).toBe(3);
    expect(out.flaky[0]?.ids).toHaveLength(1);
  });
});
