/**
 * Scripted fault-injection fixture repo for the autonomous-daemon tests.
 *
 * `createSyntheticRepo()` generates a miniature TypeScript git repo in
 * `os.tmpdir()` (nothing is committed to this repo — the fixture lives only
 * for the test run) with five planted scenarios:
 *
 * (a) `src/adder.ts` — a failing unit test (add subtracts instead of adding).
 *     The DISCOVER → SHIP happy path: fix the one line, tests go green.
 * (b) `src/mode.ts` — a cyclic oscillation trap. `test/mode-a` wants
 *     MODE === 'a', `test/mode-b` wants MODE === 'b'; both cannot pass, so
 *     fixing A breaks B and fixing B reverts A (tree hashes A→B→A).
 * (c) `scripts/fail.mjs` — a command that exits 1 with byte-identical
 *     stderr on every run (identical-error trip).
 * (d) `.github/workflows/ci.yml` — a CI workflow the daemon may never touch
 *     (`SecurityGuardrailError` via `assertPathAllowed`).
 * (e) `test/flaky.test.ts` — a pre-existing flaky test (`Math.random() > 0.5`)
 *     that must be quarantined on a clean HEAD without blocking (a).
 *
 * The repo is plain `node:test` + TypeScript run directly by Node 24's
 * type stripping — no install step, no dependencies.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../../../../src/git/git.js';

/** Exact stderr `scripts/fail.mjs` prints on every run. */
export const IDENTICAL_STDERR =
  'Error: boom — synthetic failure (identical every run)\n' + '    at fail (scripts/fail.mjs:3:11)';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? ((error as { code?: number }).code ?? -1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

export type SyntheticFix = 'adder' | 'mode-a' | 'mode-b';

export interface SyntheticRepo {
  root: string;
  headSha: string;
  /** Run the repo's tests (`node --test`, optionally one file). */
  runTests: (file?: string) => Promise<CommandResult>;
  /** Run the always-failing script (scenario c). */
  runFailingCommand: () => Promise<CommandResult>;
  /** Run the flaky test `times` times in parallel; count outcomes. */
  runFlaky: (times: number) => Promise<{ passes: number; failures: number }>;
  /** Apply a known fix; returns the new file content. */
  applyFix: (fix: SyntheticFix) => Promise<string>;
  read: (relPath: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'synthetic-repo',
      private: true,
      type: 'module',
      scripts: { test: 'node --test test/' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
      include: ['src', 'test'],
    },
    null,
    2,
  ),
  'README.md': [
    '# synthetic-repo',
    '',
    'Fault-injection fixture for the omnexx autonomous-daemon tests.',
    '',
    '- (a) `src/adder.ts` fails `test/adder.test.ts` (subtracts instead of adding).',
    '- (b) `src/mode.ts`: mode-a and mode-b tests want opposite MODE values.',
    '- (c) `scripts/fail.mjs` always fails with identical stderr.',
    '- (d) `.github/workflows/ci.yml` is denylisted for the daemon.',
    '- (e) `test/flaky.test.ts` flips a coin on every run.',
    '',
  ].join('\n'),
  'src/adder.ts': [
    '// Scenario (a): the happy path. This function is wrong on purpose.',
    'export function add(a: number, b: number): number {',
    '  return a - b;',
    '}',
    '',
  ].join('\n'),
  'test/adder.test.ts': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/adder.ts';",
    '',
    "test('adds two numbers', () => {",
    '  assert.equal(add(2, 3), 5);',
    '  assert.equal(add(0, 0), 0);',
    '});',
    '',
  ].join('\n'),
  'src/mode.ts': [
    "// Scenario (b): oscillation trap. mode-a wants MODE === 'a', mode-b",
    "// wants MODE === 'b'. Both cannot pass at once.",
    "export const MODE: 'a' | 'b' = 'a';",
    '',
  ].join('\n'),
  'test/mode-a.test.ts': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { MODE } from '../src/mode.ts';",
    '',
    "test('mode is a', () => {",
    "  assert.equal(MODE, 'a');",
    '});',
    '',
  ].join('\n'),
  'test/mode-b.test.ts': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { MODE } from '../src/mode.ts';",
    '',
    "test('mode is b', () => {",
    "  assert.equal(MODE, 'b');",
    '});',
    '',
  ].join('\n'),
  'scripts/fail.mjs': [
    '// Scenario (c): always fails with byte-identical stderr.',
    "console.error('Error: boom — synthetic failure (identical every run)');",
    "console.error('    at fail (scripts/fail.mjs:3:11)');",
    'process.exit(1);',
    '',
  ].join('\n'),
  'test/flaky.test.ts': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    '// Scenario (e): pre-existing flaky test — passes about half the time.',
    "test('flaky coin flip', () => {",
    "  assert.ok(Math.random() > 0.5, 'flaky coin flip failed');",
    '});',
    '',
  ].join('\n'),
  '.github/workflows/ci.yml': [
    '# Scenario (d): the daemon may never read or write this file.',
    'name: ci',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: npm test',
    '',
  ].join('\n'),
};

/** Generate the fixture repo in `os.tmpdir()` and commit a clean HEAD. */
export async function createSyntheticRepo(opts: { prefix?: string } = {}): Promise<SyntheticRepo> {
  const root = await mkdtemp(join(tmpdir(), opts.prefix ?? 'omnexx-synthetic-repo-'));
  for (const [rel, content] of Object.entries(FILES)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Omnexx Test']);
  await git(root, ['config', 'user.email', 'test@omnexx.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'synthetic repo: 5 planted scenarios']);
  const headSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const read = (relPath: string): Promise<string> => readFile(join(root, relPath), 'utf8');

  return {
    root,
    headSha,
    runTests: (file?: string) =>
      run('node', file === undefined ? ['--test', 'test/'] : ['--test', file], root),
    runFailingCommand: () => run('node', ['scripts/fail.mjs'], root),
    runFlaky: async (times: number) => {
      const results = await Promise.all(
        Array.from({ length: times }, () => run('node', ['--test', 'test/flaky.test.ts'], root)),
      );
      return {
        passes: results.filter((r) => r.exitCode === 0).length,
        failures: results.filter((r) => r.exitCode !== 0).length,
      };
    },
    applyFix: async (fix: SyntheticFix) => {
      if (fix === 'adder') {
        const content = await read('src/adder.ts');
        if (!content.includes('return a - b;')) throw new Error('adder fix: bug line not found');
        const next = content.replace('return a - b;', 'return a + b;');
        await writeFile(join(root, 'src/adder.ts'), next);
        return next;
      }
      const wanted = fix === 'mode-a' ? 'a' : 'b';
      const content = await read('src/mode.ts');
      const next = content.replace(/= '[ab]';/, `= '${wanted}';`);
      if (next === content) throw new Error(`mode fix: MODE line not found for ${fix}`);
      await writeFile(join(root, 'src/mode.ts'), next);
      return next;
    },
    read,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
