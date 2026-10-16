import { describe, expect, it } from 'vitest';
import type { GateConfig } from '../../../src/config/schema.js';
import type { GateResult } from '../../../src/verify/gates.js';
import {
  narrowCommand,
  relatedGate,
  relatedGreen,
  relatedRed,
  scriptCommand,
} from '../../../src/verify/related-tests.js';

const files = ['src/a.ts', 'test/a.test.ts', 'README.md'];

describe('narrowCommand', () => {
  it('turns vitest and jest runs into related runs over the changed code files', () => {
    expect(narrowCommand('npx vitest run --reporter=json', files)).toBe(
      'npx vitest related --run --passWithNoTests --reporter=json src/a.ts test/a.test.ts',
    );
    expect(narrowCommand('CI=1 node_modules/.bin/vitest', files)).toBe(
      'CI=1 node_modules/.bin/vitest related --run --passWithNoTests src/a.ts test/a.test.ts',
    );
    expect(narrowCommand('pnpm exec jest --ci', files)).toBe(
      'pnpm exec jest --ci --passWithNoTests --findRelatedTests src/a.ts test/a.test.ts',
    );
  });

  it('runs only the changed pytest files and the changed go packages, keeping options', () => {
    const py = ['pkg/core.py', 'tests/test_core.py', 'pkg/core_test.py'];
    expect(narrowCommand('python -m pytest -q -x tests/', py)).toBe(
      'python -m pytest -q -x tests/test_core.py pkg/core_test.py',
    );
    expect(narrowCommand('pytest', ['pkg/core.py'])).toBeUndefined();
    expect(narrowCommand('go test -race ./...', ['main.go', 'internal/db/db.go', 'x.md'])).toBe(
      'go test -race . ./internal/db',
    );
  });

  it('leaves alone what it cannot narrow safely', () => {
    expect(narrowCommand('npm run build && npx vitest run', files)).toBeUndefined();
    expect(narrowCommand('npx vitest --watch', files)).toBeUndefined();
    expect(narrowCommand('make test', files)).toBeUndefined();
    expect(narrowCommand('npx vitest run', ['docs/a.md'])).toBeUndefined();
    expect(narrowCommand('npx vitest run', [])).toBeUndefined();
    const many = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
    expect(narrowCommand('npx vitest run', many)).toBeUndefined();
  });

  it('quotes paths the shell would split', () => {
    expect(narrowCommand('npx jest', ["src/it's a.ts"])).toBe(
      "npx jest --passWithNoTests --findRelatedTests 'src/it'\\''s a.ts'",
    );
  });
});

describe('scriptCommand / relatedGate', () => {
  const gate: GateConfig = {
    name: 'test',
    run: 'npm test',
    level: 'must-pass',
    timeout: '5m',
    parser: 'vitest',
    flaky_reruns: 1,
    kind: 'command',
    url: '',
  };

  it('reads through npm test to the script, adding the runner a script gets for free', () => {
    expect(scriptCommand('npm test', { test: 'vitest run' })).toBe('npx vitest run');
    expect(scriptCommand('pnpm run unit', { unit: 'jest' })).toBe('pnpm exec jest');
    expect(scriptCommand('npm test', { test: 'pytest -q' })).toBe('pytest -q');
    expect(scriptCommand('npm test', {})).toBeUndefined();
    expect(relatedGate(gate, ['src/a.ts'], { test: 'vitest run' })?.run).toBe(
      'npx vitest related --run --passWithNoTests src/a.ts',
    );
    expect(relatedGate(gate, ['src/a.ts'], { test: 'tsc && vitest run' })).toBeUndefined();
    expect(relatedGate({ ...gate, kind: 'browser' }, ['src/a.ts'], {})).toBeUndefined();
  });
});

describe('relatedRed / relatedGreen', () => {
  const result = (over: Partial<GateResult>): GateResult => ({
    name: 'test',
    level: 'must-pass',
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    failures: [{ id: 'a > b', message: 'x' }] as GateResult['failures'],
    structured: true,
    logFile: '',
    ...over,
  });

  it('is red only on named failures the full gate would fail on too', () => {
    expect(relatedRed(result({}), undefined)).toBe(true);
    expect(relatedRed(result({ structured: false }), undefined)).toBe(false);
    expect(relatedRed(result({ timedOut: true }), undefined)).toBe(false);
    const pre = { test: { exitCode: 1, timedOut: false, failureIds: ['a > b'] } };
    expect(relatedRed(result({ level: 'ratchet' }), pre)).toBe(false);
  });

  it('is green only when it ran tests and they passed', () => {
    const ran = { total: 3, passed: 3, failed: 0, skipped: 0 };
    expect(relatedGreen(result({ exitCode: 0, failures: [], tests: ran }))).toBe(true);
    const none = { total: 0, passed: 0, failed: 0, skipped: 0 };
    expect(relatedGreen(result({ exitCode: 0, failures: [], tests: none }))).toBe(false);
  });
});
