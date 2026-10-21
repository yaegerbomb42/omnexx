import { describe, expect, it } from 'vitest';
import { trimOutput } from '../../../src/tools/bash.js';
import { testDigest } from '../../../src/tools/test-digest.js';

const VITEST_FAIL = `
 RUN  v3.2.4 /repo

 ❯ src/add.test.ts (1 test | 1 failed) 8ms
   × adds two numbers 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/add.test.ts > adds two numbers
AssertionError: expected 4 to be 5

- Expected
+ Received

- 5
+ 4

 ❯ node_modules/@vitest/expect/dist/index.js:99:5
 ❯ src/add.test.ts:7:28
      5| describe('add', () => {
      6|   it('adds two numbers', () => {
      7|     expect(add(2, 2)).toBe(5)
       |                            ^
      8|   })

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  2 passed | 1 failed (3)
   Start at  12:00:00
   Duration  180ms
`;

const JEST_FAIL = `
 FAIL  src/add.test.js
  ● add › adds two numbers

    expect(received).toBe(expected)

    Expected: 5
    Received: 4

      10 |
    > 11 |     expect(add(2, 2)).toBe(5);
         |                        ^
      12 |

      at Object.<anonymous> (node_modules/jest-circus/build/utils.js:100:1)
      at Object.<anonymous> (src/add.test.js:11:24)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
`;

const PYTEST_FAIL = `
============================= test session starts ==============================
collected 2 items

tests/test_math.py F.                                                   [100%]

=================================== FAILURES ===================================
__________________________________ test_add ___________________________________

    def test_add():
>       assert add(1, 1) == 3
E       AssertionError: assert 2 == 3
E        +  where 2 = add(1, 1)

tests/test_math.py:4: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_add - AssertionError: assert 2 == 3
========================= 1 failed, 1 passed in 0.02s ==========================
`;

const GO_FAIL = `
=== RUN   TestAdd
--- FAIL: TestAdd (0.00s)
    math_test.go:9: got 2 want 3
=== RUN   TestSub
--- PASS: TestSub (0.00s)
FAIL
FAIL	example.com/math	0.002s
FAIL
`;

const CARGO_FAIL = `
running 2 tests
test add::tests::adds ... FAILED
test add::tests::zero ... ok

failures:

---- add::tests::adds stdout ----

thread 'add::tests::adds' panicked at src/add.rs:7:5:
assertion \`left == right\` failed
  left: 2
 right: 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    add::tests::adds

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const PASSING_VITEST = [
  ' RUN  v3.2.4 /repo',
  ' ✓ src/add.test.ts (2 tests) 3ms',
  ' ✓ src/sub.test.ts (2 tests) 2ms',
  ' ✓ src/mul.test.ts (2 tests) 2ms',
  ' ✓ src/div.test.ts (2 tests) 2ms',
  ' ✓ src/mod.test.ts (2 tests) 2ms',
  ' Test Files  5 passed (5)',
  '      Tests  12 passed (12)',
  '   Start at  12:00:00',
  '   Duration  180ms',
  '   Typecheck  off',
].join('\n');

function expectDigest(command: string, output: string, name: string, assertion: string): void {
  const out = testDigest(command, output, 'cmd-7');
  expect(out, command).toBeDefined();
  if (!out) return;
  expect(out.length).toBeLessThanOrEqual(1500);
  expect(out).toContain('read_log id="cmd-7"');
  expect(out).toContain(name);
  expect(out).toContain(assertion);
  expect(out).not.toContain('node_modules');
}

describe('testDigest', () => {
  it('vitest: test name, assertion, and the project frame', () => {
    expectDigest('npx vitest run', VITEST_FAIL, 'adds two numbers', 'expected 4 to be 5');
    expect(testDigest('npx vitest run', VITEST_FAIL, 'cmd-7')).toContain('src/add.test.ts:7:28');
  });

  it('jest: test name, assertion, and the project frame', () => {
    expectDigest('npx jest --ci', JEST_FAIL, 'adds two numbers', 'Expected: 5');
    expect(testDigest('npx jest --ci', JEST_FAIL, 'cmd-7')).toContain('src/add.test.js:11:24');
  });

  it('pytest: test name, assertion, and the project frame', () => {
    expectDigest(
      'python -m pytest tests/test_math.py -q',
      PYTEST_FAIL,
      'tests/test_math.py::test_add',
      'assert 2 == 3',
    );
    expect(testDigest('pytest', PYTEST_FAIL, 'cmd-7')).toContain('tests/test_math.py:4');
  });

  it('go test: test name, assertion, and the project frame', () => {
    expectDigest('go test ./...', GO_FAIL, 'TestAdd', 'got 2 want 3');
    expect(testDigest('go test ./...', GO_FAIL, 'cmd-7')).toContain('math_test.go:9');
  });

  it('cargo test: test name, assertion, and the project frame', () => {
    expectDigest('cargo test --lib', CARGO_FAIL, 'add::tests::adds', 'left == right');
    expect(testDigest('cargo test', CARGO_FAIL, 'cmd-7')).toContain('src/add.rs:7:5');
  });

  it('npm test digests a vitest failure; compound and non-test commands do not', () => {
    expect(testDigest('npm test', VITEST_FAIL, 'cmd-2')).toContain('adds two numbers');
    expect(testDigest('CI=1 npm test -- --run', VITEST_FAIL, 'cmd-2')).toContain(
      'read_log id="cmd-2"',
    );
    expect(testDigest('npm test -- -t "a && b"', VITEST_FAIL, 'cmd-2')).toContain(
      'adds two numbers',
    );
    expect(testDigest('npm test && npm run lint', VITEST_FAIL, 'cmd-2')).toBeUndefined();
    expect(testDigest('npm run lint', VITEST_FAIL, 'cmd-2')).toBeUndefined();
    expect(testDigest('echo hello', VITEST_FAIL, 'cmd-2')).toBeUndefined();
  });

  it('a passing vitest log stays on the trimOutput summary path', () => {
    expect(testDigest('npx vitest run', PASSING_VITEST, 'cmd-1')).toBeUndefined();
    expect(trimOutput(PASSING_VITEST, 'cmd-1').split('\n')[0]).toBe('tests: 12 passed');
  });

  it('keeps the first failures inside 1500 chars and counts the rest', () => {
    const n = 30;
    const blocks = Array.from({ length: n }, (_, i) =>
      [
        ` FAIL  src/big.test.ts > case ${i}`,
        `AssertionError: expected ${i} to be 0 ${'x'.repeat(80)}`,
        ` ❯ src/big.test.ts:${i + 1}:1`,
        '',
      ].join('\n'),
    );
    const output = `${blocks.join('\n')}\n Test Files  1 failed (1)\n      Tests  ${n} failed (${n})\n`;
    const out = testDigest('npm test', output, 'cmd-9');
    expect(out).toBeDefined();
    if (!out) return;
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain('read_log id="cmd-9"');
    expect(out).toContain('case 0');
    expect(out).toMatch(/… \d+ more failures omitted/);
    expect(out).not.toContain('case 29');
  });

  it('deduplicates identical failures and annotates with repeats count', () => {
    const repeated = [
      ' FAIL  src/add.test.ts > adds two numbers',
      'AssertionError: expected 4 to be 5',
      ' ❯ src/add.test.ts:7:28',
      '',
      ' FAIL  src/add.test.ts > adds two numbers',
      'AssertionError: expected 4 to be 5',
      ' ❯ src/add.test.ts:7:28',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  2 failed (2)',
    ].join('\n');
    const out = testDigest('npm test', repeated, 'cmd-3');
    expect(out).toBeDefined();
    if (!out) return;
    expect(out).toContain('adds two numbers (repeats 2x)');
    expect(out).toContain('src/add.test.ts:7:28');
  });
});
