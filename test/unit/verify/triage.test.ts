import { describe, expect, it } from 'vitest';
import { withoutQuarantined } from '../../../src/core/think-loop-check.js';
import { fixNote, recallFix } from '../../../src/core/fix-memory.js';
import type { GateResult } from '../../../src/verify/gates.js';
import { judgeGate } from '../../../src/verify/ratchet.js';
import {
  classify,
  envHint,
  filesOf,
  hunksFor,
  PACKET_CHARS,
  relevantLines,
  renderTriage,
} from '../../../src/verify/triage.js';

const gate = (failures: GateResult['failures'], over: Partial<GateResult> = {}): GateResult => ({
  name: 'test',
  level: 'ratchet',
  exitCode: failures.length ? 1 : 0,
  timedOut: false,
  durationMs: 1,
  failures,
  structured: true,
  logFile: '/logs/gate-c1-loop1-test.log',
  ...over,
});

const patch = `diff --git a/src/sum.ts b/src/sum.ts
--- a/src/sum.ts
+++ b/src/sum.ts
@@ -1,3 +1,3 @@
-export const sum = (a, b) => a + b;
+export const sum = (a, b) => a - b;
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-x
+y
`;

describe('typed failure triage', () => {
  it('classifies baseline failures as pre-existing, not counted against the agent', () => {
    const r = gate([
      { id: 'old.test > broken', message: 'was broken' },
      { id: 'sum.test > adds', message: 'expected 3, got -1' },
    ]);
    const baseline = { test: { exitCode: 1, timedOut: false, failureIds: ['old.test > broken'] } };
    const input = {
      results: [r],
      verdicts: [judgeGate(r, baseline)],
      baseline,
      flaky: new Set<string>(),
      patch,
    };
    const kinds = classify(input).map((t) => [t.failure.id, t.kind]);
    expect(kinds).toEqual([
      ['old.test > broken', 'pre-existing'],
      ['sum.test > adds', 'real'],
    ]);
    const text = renderTriage(classify(input), input);
    expect(text).toContain('already failing before this run');
    expect(text).toContain('not your job unless the goal says so');
  });

  it('marks quarantined ids flaky, and a gate failing only on them passes', () => {
    const r = gate([{ id: 'net.test > retries', message: 'timeout' }], { level: 'must-pass' });
    const flaky = new Set(['net.test > retries']);
    const kinds = classify({
      results: [r],
      verdicts: [judgeGate(r, undefined)],
      baseline: undefined,
      flaky,
      patch: '',
    });
    expect(kinds[0]?.kind).toBe('flaky');
    const cleaned = withoutQuarantined(r, flaky);
    expect(cleaned.failures).toEqual([]);
    expect(judgeGate(cleaned, undefined).pass).toBe(true);
    expect(withoutQuarantined(r, new Set())).toBe(r);
  });

  it.each([
    ['sh: 1: pytest: not found', 'pytest'],
    ['zsh: command not found: rg', 'rg'],
    ["Error: Cannot find module 'left-pad'", 'left-pad'],
    ["ModuleNotFoundError: No module named 'requests'", 'requests'],
    ['Error: listen EADDRINUSE: address already in use :::3000', 'port'],
    ['environment variable DATABASE_URL is not set', 'DATABASE_URL'],
  ])('gives a typed environment hint for %s', (msg, expected) => {
    expect(envHint(msg)).toContain(expected);
  });

  it('treats an unresolved relative import as a real failure, not a missing dependency', () => {
    expect(envHint("Cannot find module './util'")).toBeUndefined();
  });

  it('builds a compact failure packet: name, assertion, project frames only, the diff hunk', () => {
    const message = [
      'AssertionError: expected -1 to be 3',
      '    at Object.<anonymous> (src/sum.test.ts:4:10)',
      '    at run (node_modules/vitest/dist/runner.js:1:1)',
      '    at src/sum.ts:1:30',
    ].join('\n');
    const r = gate([{ id: 'sum.test > adds', location: 'src/sum.test.ts:4', message }]);
    const input = {
      results: [r],
      verdicts: [judgeGate(r, undefined)],
      baseline: undefined,
      flaky: new Set<string>(),
      patch,
    };
    const text = renderTriage(classify(input), input);
    expect(text).toContain('sum.test > adds');
    expect(text).toContain('expected -1 to be 3');
    expect(text).not.toContain('node_modules');
    expect(text).toContain('Your diff in src/sum.ts');
    expect(text).toContain('+export const sum = (a, b) => a - b;');
    expect(text).not.toContain('src/other.ts');
    expect(text).toContain('read_log /logs/gate-c1-loop1-test.log');
  });

  it('keeps the packet under its size cap however much fails', () => {
    const failures = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      message: `AssertionError ${'z'.repeat(500)}\n${'line\n'.repeat(40)}`,
    }));
    const r = gate(failures);
    const input = {
      results: [r],
      verdicts: [judgeGate(r, undefined)],
      baseline: undefined,
      flaky: new Set<string>(),
      patch,
    };
    const text = renderTriage(classify(input), input);
    expect(text.length).toBeLessThanOrEqual(PACKET_CHARS);
    expect(text).toContain('more');
  });

  it('helpers: relevant lines, files, hunks', () => {
    expect(relevantLines('a\nb\nc\nd\n  at x (node_modules/y.js:1:1)')).toEqual(['a', 'b', 'c']);
    expect(filesOf({ id: 'x', message: 'at src/a.ts:1\nat node_modules/b.js:2' })).toEqual([
      'src/a.ts',
    ]);
    expect(hunksFor(patch, 'src/missing.ts')).toBe('');
  });
});

describe('fix memory', () => {
  it('recalls the fix recorded for a signature, and nothing for another', () => {
    const note = fixNote(
      'gate test: 1 new failure(s) | sum.test > adds',
      'swapped - back to +',
      '2026-10-15',
    );
    expect(note.text.length).toBeLessThanOrEqual(400);
    const notes = [{ ...note, id: 'N1' }];
    expect(recallFix(notes, 'gate test: 1 new failure(s) | sum.test > adds')).toContain(
      'swapped - back to +',
    );
    expect(recallFix(notes, 'something else')).toBeUndefined();
  });
});
