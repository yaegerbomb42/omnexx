import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../../../src/git/git.js';
import {
  createWorktree,
  listWorktrees,
  removeWorktreeByPath,
  runBranch,
} from '../../../src/git/worktree.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

async function seeded(): Promise<string> {
  const repo = await tempRepo();
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  return repo;
}

describe('worktree listing and removal by path', () => {
  it('lists nothing when the worktrees root does not exist', async () => {
    expect(await listWorktrees(join(await tempDir(), 'missing'))).toEqual([]);
  });

  it('lists worktrees newest first with run ids parsed from the name', async () => {
    const repo = await seeded();
    const root = await tempDir();
    const wt = await createWorktree(repo, root, 'r_abc');
    await mkdir(join(root, 'not-a-run'));
    const entries = await listWorktrees(root);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.path === wt.path)?.runId).toBe('r_abc');
    expect(entries.find((e) => e.path.endsWith('not-a-run'))?.runId).toBeUndefined();
    expect(entries[0]?.mtimeMs ?? 0).toBeGreaterThanOrEqual(entries[1]?.mtimeMs ?? 0);
    expect(wt.branch).toBe(runBranch('r_abc'));
  });

  it('removes a linked worktree through its .git file, and a plain directory by deleting it', async () => {
    const repo = await seeded();
    const root = await tempDir();
    const wt = await createWorktree(repo, root, 'r_rm');
    expect(await removeWorktreeByPath(wt.path)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    const list = await git(repo, ['worktree', 'list']);
    expect(list.stdout).not.toContain(wt.path);

    const plain = join(root, 'plain');
    await mkdir(plain);
    await writeFile(join(plain, 'x'), 'x');
    expect(await removeWorktreeByPath(plain)).toBe(true);
    expect(existsSync(plain)).toBe(false);
  });
});
