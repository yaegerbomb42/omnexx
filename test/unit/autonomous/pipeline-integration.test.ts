import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { git } from '../../../src/git/git.js';
import type { RunCommand, RunCommandResult } from '../../../src/autonomous/ast-analysis.js';
import {
  FlakeIsolationController,
  isTestRelatedToTask,
  type FlakeStore,
} from '../../../src/autonomous/flake-detector.js';
import {
  VerificationPipeline,
  type VerificationTask,
} from '../../../src/autonomous/verification-pipeline.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

const ok = (stdout = ''): RunCommandResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
});
const fail = (stdout = ''): RunCommandResult => ({
  stdout,
  stderr: '',
  exitCode: 1,
  timedOut: false,
  durationMs: 5,
});

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
}

describe('VerificationPipeline.verify (stubbed commands, real git repo)', () => {
  it('PASSes a test_runner task end to end, and restores src after Stage 3', async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'test', 'unit'), { recursive: true });
    await writeFile(
      join(repo, 'src', 'greet.ts'),
      `export function greet(): string {\n  return 'hi';\n}\n`,
    );
    await writeFile(
      join(repo, 'test', 'unit', 'greet.test.ts'),
      `import { expect, it } from 'vitest';\nimport { greet } from '../../../src/greet.js';\n\nit('greets', () => {\n  expect(greet()).toBe('hi');\n});\n`,
    );
    await commitAll(repo, 'baseline');

    // The task: greet() now returns 'hello'; the test proves the new behaviour.
    await writeFile(
      join(repo, 'src', 'greet.ts'),
      `export function greet(): string {\n  return 'hello';\n}\n`,
    );
    await writeFile(
      join(repo, 'test', 'unit', 'greet.test.ts'),
      `import { expect, it } from 'vitest';\nimport { greet } from '../../../src/greet.js';\n\nit('greets', () => {\n  expect(greet()).toBe('hello');\n  expect(greet().length).toBe(5);\n});\n`,
    );

    let testFileRuns = 0;
    const runCommand: RunCommand = async (command, args, opts) => {
      if (command === 'npx' && args[0] === 'tsc') return ok();
      if (command === 'npx' && args[0] === 'eslint') return ok('[]');
      if (command === 'npx' && args[0] === '--no-install') return fail(); // knip absent
      if (command === 'npx' && args[0] === 'vitest') {
        if (args.includes('--coverage')) {
          const out = args
            .find((a) => a.startsWith('--outputFile='))
            ?.slice('--outputFile='.length);
          if (out) {
            await writeFile(
              out,
              JSON.stringify({
                numTotalTests: 1,
                numPassedTests: 1,
                numFailedTests: 0,
                testResults: [],
              }),
            );
          }
          await mkdir(join(opts.cwd, 'coverage'), { recursive: true });
          await writeFile(
            join(opts.cwd, 'coverage', 'coverage-summary.json'),
            JSON.stringify({ total: { lines: { pct: 90 }, branches: { pct: 85 } } }),
          );
          return ok();
        }
        testFileRuns++;
        // 1st: Stage 2 related run (pass); 2nd: Stage 3 unpatched (must fail);
        // 3rd: Stage 3 patched (pass).
        return testFileRuns === 2 ? fail('expected hello, got hi') : ok();
      }
      return ok();
    };

    const task: VerificationTask = {
      id: 't1',
      title: 'greet returns hello',
      kind: 'test_runner',
      finding: 'greet() returns the wrong greeting',
    };
    const pipeline = new VerificationPipeline({ runCommand });
    const result = await pipeline.verify(task, repo, {
      criticFn: () =>
        Promise.resolve({
          logic_soundness: 5,
          minimal_diff: 5,
          convention_compliance: 5,
          unintended_side_effects: 5,
          verdict: 'APPROVE',
        }),
    });

    expect(result.outcome).toBe('PASS');
    expect(result.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      '0:pass',
      '1:pass',
      '2:pass',
      '3:pass',
      '4:pass',
    ]);
    expect(result.bloatNeedsHumanReview).toBe(false);
    // Stage 3 restored the patch: the worktree still holds the new behaviour.
    expect(await readFile(join(repo, 'src', 'greet.ts'), 'utf8')).toContain(`'hello'`);
    expect(testFileRuns).toBe(3);
  });

  it('REPAIRs on a static failure at round 0 and FAILs (quarantine) at round 2', async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), `export const a = 1;\n`);
    await commitAll(repo, 'baseline');
    await writeFile(join(repo, 'src', 'a.ts'), `export const a = 2;\n`);

    const failingTsc: RunCommand = (command, args) => {
      if (command === 'npx' && args[0] === 'tsc') {
        return Promise.resolve(fail('src/a.ts(1,1): error TS2322: Type mismatch'));
      }
      return Promise.resolve(ok('[]'));
    };
    const task: VerificationTask = { id: 't2', title: 'bump a', kind: 'feature' };
    const pipeline = new VerificationPipeline({ runCommand: failingTsc });

    const round0 = await pipeline.verify(task, repo, { repairRound: 0 });
    expect(round0.outcome).toBe('REPAIR');
    expect(round0.stages[1]?.status).toBe('fail');
    expect(round0.diagnostics.join(' ')).toMatch(/tsc failed/);

    const round2 = await pipeline.verify(task, repo, { repairRound: 2 });
    expect(round2.outcome).toBe('FAIL');
  });

  it('FAILs immediately on a Stage 0 safety violation (forbidden path)', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'CLAUDE.md'), '# rules\n');
    await writeFile(join(repo, 'src-a.ts'), `export const a = 1;\n`);
    await commitAll(repo, 'baseline');
    await writeFile(join(repo, 'CLAUDE.md'), '# rules changed\n');

    const pipeline = new VerificationPipeline({ runCommand: () => Promise.resolve(ok('[]')) });
    const result = await pipeline.verify({ id: 't3', title: 'edit rules', kind: 'other' }, repo, {
      repairRound: 0,
    });
    expect(result.outcome).toBe('FAIL');
    expect(result.diagnostics.join(' ')).toMatch(/forbidden path.*CLAUDE\.md/);
  });

  it('flags net-LoC bloat for human review without failing the task', async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), `export const a = 1;\n`);
    await commitAll(repo, 'baseline');
    const big = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    await writeFile(join(repo, 'src', 'a.ts'), `${big}\n`);

    const pipeline = new VerificationPipeline({ runCommand: () => Promise.resolve(ok('[]')) });
    const result = await pipeline.verify(
      { id: 't4', title: 'big feature', kind: 'feature' },
      repo,
      { runStage3: false },
    );
    // Stage 1/2 run against the stubbed commands; bloat flag is independent.
    expect(result.bloatNeedsHumanReview).toBe(true);
    expect(result.netLoc).toBeGreaterThan(150);
  });

  it('exempts lockfiles from net-LoC bloat calculation', async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'package-lock.json'), `{\n  "name": "root",\n  "version": "1.0.0"\n}\n`);
    await commitAll(repo, 'baseline');
    const bigLock = Array.from({ length: 500 }, (_, i) => `    "dep-${i}": { "version": "1.0.0" },`).join('\n');
    await writeFile(join(repo, 'package-lock.json'), `{\n${bigLock}\n}\n`);

    const pipeline = new VerificationPipeline({ runCommand: () => Promise.resolve(ok('[]')) });
    const result = await pipeline.verify(
      { id: 't5', title: 'bump deps', kind: 'other' },
      repo,
      { runStage3: false },
    );
    expect(result.bloatNeedsHumanReview).toBe(false);
    expect(result.netLoc).toBe(0);
  });
});

describe('VerificationPipeline: test-gaming (live case 2026-11-06)', () => {
  const ADDER_SRC = `export const add = (a: number, b: number): number => a * b;\n`;
  const ADDER_TEST_HEAD = `import { expect, it } from 'vitest';
import { add } from '../src/adder.js';

it('adds', () => {
  expect(add(2, 3)).toBe(5);
});
`;

  async function adderRepo(): Promise<string> {
    const repo = await tempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'test'), { recursive: true });
    await writeFile(join(repo, 'src', 'adder.ts'), ADDER_SRC, 'utf8');
    await writeFile(join(repo, 'test', 'adder.test.ts'), ADDER_TEST_HEAD, 'utf8');
    await commitAll(repo, 'baseline');
    return repo;
  }

  it('FAILs the live case end to end: test-only toBe(5) → toBe(6) with src untouched', async () => {
    const repo = await adderRepo();
    await writeFile(
      join(repo, 'test', 'adder.test.ts'),
      ADDER_TEST_HEAD.replace('toBe(5)', 'toBe(6)'),
      'utf8',
    );
    const pipeline = new VerificationPipeline({ runCommand: () => Promise.resolve(ok()) });
    const result = await pipeline.verify(
      {
        id: 't-live',
        title: 'add() multiplies instead of adding',
        kind: 'test_runner',
        finding: 'add(2, 3) returns 6',
      },
      repo,
      { repairRound: 0 },
    );

    expect(result.outcome).toBe('FAIL');
    expect(result.stages[0]?.status).toBe('fail');
    expect(result.diagnostics.join(' ')).toMatch(/weakened test expectation/);
    expect(result.diagnostics.join(' ')).toMatch(/test-only diff/);
  });

  it('runStage3 fails a test-only diff that rewrites expectations', async () => {
    const repo = await adderRepo();
    await writeFile(
      join(repo, 'test', 'adder.test.ts'),
      ADDER_TEST_HEAD.replace('toBe(5)', 'toBe(6)'),
      'utf8',
    );
    const pipeline = new VerificationPipeline({});
    const stage = await pipeline.runStage3(repo, {
      files: ['test/adder.test.ts'],
      status: new Map([['test/adder.test.ts', 'M']]),
      diff: '',
      linesAdded: 1,
      linesDeleted: 1,
    });

    expect(stage.status).toBe('fail');
    expect(stage.diagnostics.join(' ')).toMatch(/without any source change/);
  });

  it('runStage3 still skips a test-only diff that only adds tests', async () => {
    const repo = await adderRepo();
    await writeFile(
      join(repo, 'test', 'adder.test.ts'),
      ADDER_TEST_HEAD.replace(
        '});',
        `});\n\nit('adds zero', () => {\n  expect(add(0, 0)).toBe(0);\n});`,
      ),
      'utf8',
    );
    const pipeline = new VerificationPipeline({});
    const stage = await pipeline.runStage3(repo, {
      files: ['test/adder.test.ts'],
      status: new Map([['test/adder.test.ts', 'M']]),
      diff: '',
      linesAdded: 3,
      linesDeleted: 0,
    });

    expect(stage.status).toBe('skipped');
    expect(stage.details).toMatch(/no src changes/);
  });
});

describe('FlakeIsolationController', () => {
  it('detects relatedness through the import graph', async () => {
    const repo = await tempDir('omnexx-flake-rel-');
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'test'), { recursive: true });
    await writeFile(
      join(repo, 'src', 'calc.ts'),
      `export const add = (a: number, b: number): number => a + b;\n`,
    );
    await writeFile(
      join(repo, 'test', 'calc.test.ts'),
      `import { add } from '../src/calc.js';\nimport { expect, it } from 'vitest';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n`,
    );
    expect(isTestRelatedToTask('test/calc.test.ts', ['src/calc.ts'], repo)).toBe(true);
    expect(isTestRelatedToTask('test/calc.test.ts', ['src/other.ts'], repo)).toBe(false);
  });

  async function preparedCleanWorktree(): Promise<string> {
    const dir = await tempDir('omnexx-flake-clean-');
    await mkdir(join(dir, 'node_modules', 'vitest'), { recursive: true });
    await mkdir(join(dir, 'test'), { recursive: true });
    await writeFile(join(dir, 'test', 'flaky.test.ts'), `it('flaky', () => {});\n`);
    return dir;
  }

  it('classifies a test failing on clean HEAD as a pre-existing flake', async () => {
    const clean = await preparedCleanWorktree();
    const record = vi.fn();
    const store: FlakeStore = { record };
    let runs = 0;
    const runCommand: RunCommand = () => {
      runs++;
      return Promise.resolve(runs <= 2 ? fail('boom') : ok()); // fails 2/3 on clean HEAD
    };
    const controller = new FlakeIsolationController({ runCommand });
    const result = await controller.investigate({
      file: 'test/flaky.test.ts',
      name: 'flaky',
      worktreePath: clean,
      baseHead: 'a'.repeat(40),
      taskTouchedFiles: ['src/unrelated.ts'],
      cleanWorktreePath: clean,
      store,
    });
    expect(result.verdict).toBe('pre-existing-flake');
    expect(result.excludedFromGate).toBe(true);
    expect(result.cleanHeadRuns).toEqual({ passed: 1, failed: 2 });
    expect(result.enqueue).toMatchObject({ kind: 'flake_remediation', severity: 1.0, score: 92.0 });
    expect(record).toHaveBeenCalledOnce();
    expect(runs).toBe(3);
  });

  it('classifies a test passing 3/3 on clean HEAD as a real regression', async () => {
    const clean = await preparedCleanWorktree();
    const controller = new FlakeIsolationController({ runCommand: () => Promise.resolve(ok()) });
    const result = await controller.investigate({
      file: 'test/flaky.test.ts',
      name: 'flaky',
      worktreePath: clean,
      baseHead: 'a'.repeat(40),
      taskTouchedFiles: ['src/unrelated.ts'],
      cleanWorktreePath: clean,
    });
    expect(result.verdict).toBe('real-regression');
    expect(result.excludedFromGate).toBe(false);
    expect(result.enqueue).toBeUndefined();
  });

  it('short-circuits related tests as real regressions without isolation runs', async () => {
    const clean = await preparedCleanWorktree();
    const runCommand = vi.fn(() => Promise.resolve(ok()));
    const controller = new FlakeIsolationController({
      runCommand: runCommand as unknown as RunCommand,
    });
    const result = await controller.investigate({
      file: 'test/flaky.test.ts',
      name: 'flaky',
      worktreePath: clean,
      baseHead: 'a'.repeat(40),
      taskTouchedFiles: ['test/flaky.test.ts'],
      cleanWorktreePath: clean,
    });
    expect(result.verdict).toBe('real-regression');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('fails closed when the clean worktree has no dependencies', async () => {
    const bare = await tempDir('omnexx-flake-bare-');
    await mkdir(join(bare, 'test'), { recursive: true });
    await writeFile(join(bare, 'test', 'flaky.test.ts'), `it('flaky', () => {});\n`);
    const runCommand = vi.fn(() => Promise.resolve(fail()));
    const controller = new FlakeIsolationController({
      runCommand: runCommand as unknown as RunCommand,
    });
    const result = await controller.investigate({
      file: 'test/flaky.test.ts',
      name: 'flaky',
      worktreePath: bare,
      baseHead: 'a'.repeat(40),
      taskTouchedFiles: ['src/unrelated.ts'],
      cleanWorktreePath: bare,
    });
    expect(result.verdict).toBe('real-regression');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
