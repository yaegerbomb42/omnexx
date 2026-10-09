import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git/git.js';

/**
 * The working tree (tracked and untracked, not ignored files) as a git tree object, written
 * through a throwaway index so the person's index, stash and branches are never touched.
 * Undefined outside a git repository.
 */
export async function snapshotTree(root: string): Promise<string | undefined> {
  const index = join(tmpdir(), `omnexx-snap-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const add = await git(root, ['add', '-A'], { allowFailure: true, env });
    if (add.exitCode !== 0) return undefined;
    const tree = await git(root, ['write-tree'], { allowFailure: true, env });
    return tree.exitCode === 0 ? tree.stdout.trim() : undefined;
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * Put the working tree back to `tree`: changed and deleted files are restored, files created
 * since are removed. Returns the paths it touched.
 */
export async function restoreTree(root: string, tree: string): Promise<string[]> {
  const now = await snapshotTree(root);
  if (!now || now === tree) return [];
  const diff = await git(root, ['diff', '--name-status', '--no-renames', '-z', tree, now]);
  const parts = diff.stdout.split('\0').filter(Boolean);
  const touched: string[] = [];
  const restore: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const path = parts[i + 1] ?? '';
    touched.push(path);
    if (status === 'A') await rm(join(root, path), { force: true });
    else restore.push(path);
  }
  if (restore.length)
    await git(root, ['restore', `--source=${tree}`, '--worktree', '--', ...restore]);
  return touched;
}
