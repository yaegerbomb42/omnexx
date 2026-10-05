import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { GitError } from '../errors.js';
import { git } from './git.js';
import { resolveRef } from './repo.js';

export interface Worktree {
  path: string;
  branch: string;
  startRef: string;
}

export const runBranch = (runId: string): string => `omnexx/${runId}`;

/**
 * Create `omnexx/<runId>` from `from` in a new worktree outside the repo. The user's checkout,
 * HEAD, index and working files are never touched; git only records the worktree in `.git`.
 */
export async function createWorktree(
  repo: string,
  worktreesRoot: string,
  runId: string,
  from = 'HEAD',
): Promise<Worktree> {
  const startRef = await resolveRef(repo, from);
  const branch = runBranch(runId);
  const path = join(worktreesRoot, `${basename(repo)}-${runId}`);
  await mkdir(worktreesRoot, { recursive: true });
  const r = await git(repo, ['worktree', 'add', '-b', branch, path, startRef], {
    allowFailure: true,
  });
  if (r.exitCode !== 0)
    throw new GitError(`cannot create worktree for ${runId}: ${r.stderr.trim()}`);
  return { path, branch, startRef };
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path], { allowFailure: true });
  await git(repo, ['worktree', 'prune'], { allowFailure: true });
}
