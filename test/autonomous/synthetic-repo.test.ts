/**
 * Fixture-repo self-tests: prove the five planted scenarios in
 * `fixtures/synthetic-repo` behave as the daemon tests assume.
 *
 * (a) adder test fails on a clean HEAD, passes after the one-line fix.
 * (b) mode-a/mode-b cannot both pass; flipping MODE flips which test fails.
 * (c) the failing script exits 1 with byte-identical stderr, 3 runs in a row.
 * (d) `.github/workflows/ci.yml` exists and the real guardrail denies writes
 *     to it with `SecurityGuardrailError`.
 * (e) the flaky test passes AND fails across 20 runs, and never changes
 *     whether the adder test fails.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPathAllowed,
  isPathAllowed,
  SecurityGuardrailError,
} from '../../src/autonomous/tool-guard.js';
import { git } from '../../src/git/git.js';
import {
  createSyntheticRepo,
  IDENTICAL_STDERR,
  type SyntheticRepo,
} from './fixtures/synthetic-repo/index.js';

let repo: SyntheticRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

describe('synthetic-repo fixture', () => {
  it('generates a clean git repo in os.tmpdir() with a committed HEAD', async () => {
    repo = await createSyntheticRepo();
    expect(repo.root).toContain('omnexx-synthetic-repo-');
    expect(existsSync(join(repo.root, '.git'))).toBe(true);
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/);
    const status = await git(repo.root, ['status', '--porcelain']);
    expect(status.stdout).toBe('');
  });

  it('(a) adder test fails on clean HEAD and passes after the one-line fix', async () => {
    repo = await createSyntheticRepo();
    const before = await repo.runTests('test/adder.test.ts');
    expect(before.exitCode).toBe(1);
    // node --test prints TAP results to stdout, not stderr.
    expect(before.stdout).toMatch(/add/);

    const fixed = await repo.applyFix('adder');
    expect(fixed).toContain('return a + b;');
    const after = await repo.runTests('test/adder.test.ts');
    expect(after.exitCode).toBe(0);
    const diff = await git(repo.root, ['diff', '--numstat']);
    expect(diff.stdout.trim().split('\n')).toHaveLength(1);
    expect(diff.stdout).toMatch(/src\/adder\.ts/);
  });

  it('(b) mode-a and mode-b oscillate: fixing one breaks the other', async () => {
    repo = await createSyntheticRepo();
    const aPass = await repo.runTests('test/mode-a.test.ts');
    const bFail = await repo.runTests('test/mode-b.test.ts');
    expect(aPass.exitCode).toBe(0);
    expect(bFail.exitCode).toBe(1);

    await repo.applyFix('mode-b');
    expect((await repo.runTests('test/mode-a.test.ts')).exitCode).toBe(1);
    expect((await repo.runTests('test/mode-b.test.ts')).exitCode).toBe(0);

    await repo.applyFix('mode-a');
    expect((await repo.runTests('test/mode-a.test.ts')).exitCode).toBe(0);
    expect((await repo.runTests('test/mode-b.test.ts')).exitCode).toBe(1);
  });

  it('(c) failing command exits 1 with identical stderr three runs in a row', async () => {
    repo = await createSyntheticRepo();
    const runs = await Promise.all([
      repo.runFailingCommand(),
      repo.runFailingCommand(),
      repo.runFailingCommand(),
    ]);
    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(run.stderr.trim()).toBe(IDENTICAL_STDERR);
    }
  });

  it('(d) ci.yml exists and the guardrail denies writing it', async () => {
    repo = await createSyntheticRepo();
    expect(existsSync(join(repo.root, '.github/workflows/ci.yml'))).toBe(true);
    expect(isPathAllowed('.github/workflows/ci.yml', 'write')).toBe(false);
    expect(isPathAllowed('.github/workflows/ci.yml', 'read')).toBe(false);
    expect(() => {
      assertPathAllowed('.github/workflows/ci.yml', 'write');
    }).toThrow(SecurityGuardrailError);
    expect(() => {
      assertPathAllowed('.github/workflows/ci.yml', 'write');
    }).toThrow(/denylist rule \.github\/workflows\/\*\*/);
    expect(isPathAllowed('src/adder.ts', 'write')).toBe(true);
    expect(isPathAllowed('package-lock.json', 'write')).toBe(false); // lockfile rule
  });

  it('(e) flaky test passes and fails across runs, without affecting the adder test', async () => {
    repo = await createSyntheticRepo();
    const { passes, failures } = await repo.runFlaky(20);
    expect(passes).toBeGreaterThan(0);
    expect(failures).toBeGreaterThan(0);
    expect(passes + failures).toBe(20);
    expect(await repo.read('test/flaky.test.ts')).toContain('Math.random() > 0.5');

    // The flaky test's presence does not change the deterministic (a) outcome.
    expect((await repo.runTests('test/adder.test.ts')).exitCode).toBe(1);
  });

  it('cleanup removes the temp directory', async () => {
    repo = await createSyntheticRepo();
    const root = repo.root;
    expect(existsSync(root)).toBe(true);
    await repo.cleanup();
    expect(existsSync(root)).toBe(false);
    repo = undefined;
  });
});
