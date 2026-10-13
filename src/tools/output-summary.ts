/**
 * The outcome of a test run in one line ("40 passed, 2 failed"), read from the summary the
 * common runners print, so a trimmed command result leads with what matters. No model involved.
 */

interface Counts {
  passed?: number | undefined;
  failed?: number | undefined;
  skipped?: number | undefined;
}

const num = (m: RegExpExecArray | null, i = 1): number | undefined =>
  m?.[i] === undefined ? undefined : Number(m[i]);

/** Each runner's final summary; the last one that matches the output wins. */
const RUNNERS: ((text: string) => Counts | undefined)[] = [
  // vitest: "Tests  40 passed | 2 failed (42)"
  (t) => {
    const line = /^\s*Tests\s{2,}(.+)$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: num(/(\d+) passed/.exec(line)),
      failed: num(/(\d+) failed/.exec(line)),
      skipped: num(/(\d+) skipped/.exec(line)),
    };
  },
  // jest: "Tests:       2 failed, 40 passed, 42 total"
  (t) => {
    const line = /^Tests:\s+(.+)$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: num(/(\d+) passed/.exec(line)),
      failed: num(/(\d+) failed/.exec(line)),
      skipped: num(/(\d+) skipped/.exec(line)),
    };
  },
  // pytest: "==== 2 failed, 42 passed, 1 skipped in 1.23s ===="
  (t) => {
    const line = /^=+ (.+ in [\d.]+s.*) =+$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: num(/(\d+) passed/.exec(line)),
      failed: num(/(\d+) failed/.exec(line)),
      skipped: num(/(\d+) skipped/.exec(line)),
    };
  },
  // node:test (TAP): "# pass 40" / "# fail 2"
  (t) => {
    const pass = num(/^# pass (\d+)$/m.exec(t));
    if (pass === undefined) return undefined;
    return { passed: pass, failed: num(/^# fail (\d+)$/m.exec(t)) };
  },
  // mocha: "40 passing (2s)" / "2 failing"
  (t) => {
    const pass = num(/^\s*(\d+) passing\b/m.exec(t));
    if (pass === undefined) return undefined;
    return { passed: pass, failed: num(/^\s*(\d+) failing\b/m.exec(t)) };
  },
  // cargo: "test result: FAILED. 40 passed; 2 failed; 0 ignored"
  (t) => {
    const line = /^test result: \w+\. (.+)$/m.exec(t)?.[1];
    if (!line) return undefined;
    return { passed: num(/(\d+) passed/.exec(line)), failed: num(/(\d+) failed/.exec(line)) };
  },
];

export function testSummary(output: string): string | undefined {
  let found: Counts | undefined;
  for (const runner of RUNNERS) found = runner(output) ?? found;
  if (!found || (found.passed === undefined && found.failed === undefined)) return undefined;
  const parts = [
    found.passed !== undefined ? `${String(found.passed)} passed` : '',
    found.failed ? `${String(found.failed)} failed` : '',
    found.skipped ? `${String(found.skipped)} skipped` : '',
  ].filter(Boolean);
  return parts.join(', ');
}
