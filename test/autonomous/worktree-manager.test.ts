/**
 * WorktreeManager ship-commit tests: the ship commit must never include
 * verification/daemon artifacts — the `node_modules` symlink, `coverage/`
 * output, or `.omnexx/` state — even though verification writes them into
 * the worktree right before the commit (found live 2026-11-06, when the
 * shipped branch contained `coverage/coverage-summary.json` and a
 * `node_modules` symlink pointing at an absolute VM path).
 */
import { lstat } from 'node:fs/promises';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager, parseStatusPaths } from '../../src/autonomous/worktree-manager.js';
import { git } from '../../src/git/git.js';
import { createSyntheticRepo, type SyntheticRepo } from './fixtures/synthetic-repo/index.js';

let repo: SyntheticRepo | undefined;
let manager: WorktreeManager | undefined;
const taskIds: string[] = [];

async function makeWorktree(taskId: string): Promise<string> {
  if (repo === undefined || manager === undefined) throw new Error('test setup failed');
  taskIds.push(taskId);
  const info = await manager.create(taskId, repo.headSha);
  return info.path;
}

/** Files in a commit, via `git diff-tree`. */
async function commitFiles(worktreePath: string, sha: string): Promise<string[]> {
  const out = await git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
  return out.stdout.split('\n').filter(Boolean).sort();
}

/** Plant the artifacts the live test shipped by accident. */
async function plantArtifacts(worktreePath: string): Promise<void> {
  if (repo === undefined) throw new Error('test setup failed');
  // A real node_modules dir in the main checkout, linked into the worktree
  // exactly as WorktreeManager.create does (commit 15a0620).
  const realModules = join(repo.root, 'node_modules');
  await mkdir(realModules, { recursive: true });
  await writeFile(join(realModules, 'dummy.js'), 'export {};\n');
  await symlink(realModules, join(worktreePath, 'node_modules'), 'dir');
  // Coverage output written by the `--coverage` vitest run.
  await mkdir(join(worktreePath, 'coverage'), { recursive: true });
  await writeFile(
    join(worktreePath, 'coverage', 'coverage-summary.json'),
    JSON.stringify({ total: {} }),
  );
  // Daemon state inside the worktree.
  await mkdir(join(worktreePath, '.omnexx'), { recursive: true });
  await writeFile(join(worktreePath, '.omnexx', 'state.json'), '{}\n');
}

async function fixAdder(worktreePath: string): Promise<void> {
  const path = join(worktreePath, 'src/adder.ts');
  const content = await readFile(path, 'utf8');
  await writeFile(path, content.replace('return a - b;', 'return a + b;'));
}

afterEach(async () => {
  for (const taskId of taskIds.splice(0)) {
    await manager?.destroy(taskId).catch(() => undefined);
  }
  manager = undefined;
  await repo?.cleanup();
  repo = undefined;
});

describe('parseStatusPaths', () => {
  it('takes the new path of a rename, not the old one', () => {
    expect(
      parseStatusPaths('R  src/old.ts\0src/new.ts\0 M src/adder.ts\0?? src/fresh.ts\0'),
    ).toEqual(['src/new.ts', 'src/adder.ts', 'src/fresh.ts']);
  });

  it('returns [] for a clean tree', () => {
    expect(parseStatusPaths('')).toEqual([]);
  });
});

describe('WorktreeManager.commit ship exclusion', () => {
  it('commits only the source edit; artifacts stay out of the commit and on disk', async () => {
    repo = await createSyntheticRepo();
    manager = new WorktreeManager({ repoRoot: repo.root });
    const worktreePath = await makeWorktree('ship-exclusion');

    await fixAdder(worktreePath);
    await plantArtifacts(worktreePath);

    const sha = await manager.commit('ship-exclusion', 'daemon: fix adder');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitFiles(worktreePath, sha)).toEqual(['src/adder.ts']);

    // The symlink survives the commit: verification keeps resolving deps
    // through it; only the commit excludes it.
    const stat = await lstat(join(worktreePath, 'node_modules'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('throws when only excluded artifacts changed (nothing shippable)', async () => {
    repo = await createSyntheticRepo();
    manager = new WorktreeManager({ repoRoot: repo.root });
    const worktreePath = await makeWorktree('artifacts-only');

    await plantArtifacts(worktreePath);

    await expect(manager.commit('artifacts-only', 'daemon: nothing real')).rejects.toThrow(
      /no changes to commit/,
    );
    // And the artifacts are still on disk, untouched by the failed commit.
    const stat = await lstat(join(worktreePath, 'node_modules'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('still commits a plain source-only change, including a new untracked file', async () => {
    repo = await createSyntheticRepo();
    manager = new WorktreeManager({ repoRoot: repo.root });
    const worktreePath = await makeWorktree('plain-commit');

    await fixAdder(worktreePath);
    await writeFile(join(worktreePath, 'src/helper.ts'), 'export const HELLO = 1;\n');

    const sha = await manager.commit('plain-commit', 'daemon: fix adder + helper');
    expect(await commitFiles(worktreePath, sha)).toEqual(['src/adder.ts', 'src/helper.ts']);
  });

  it('throws when there is nothing to commit at all', async () => {
    repo = await createSyntheticRepo();
    manager = new WorktreeManager({ repoRoot: repo.root });
    await makeWorktree('empty-commit');

    await expect(manager.commit('empty-commit', 'daemon: nothing')).rejects.toThrow(
      /no changes to commit/,
    );
  });
});
