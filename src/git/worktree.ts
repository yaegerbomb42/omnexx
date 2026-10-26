import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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

export interface WorktreeEntry {
  path: string;
  /** Run id parsed from `<repo>-<runId>`, when the name matches. */
  runId?: string | undefined;
  /** Directory mtime (creation is close enough when the run state is gone). */
  mtimeMs: number;
}

/** Every worktree under `~/.omnexx/worktrees`, newest first. */
export async function listWorktrees(worktreesRoot: string): Promise<WorktreeEntry[]> {
  let names: string[];
  try {
    names = await readdir(worktreesRoot);
  } catch {
    return [];
  }
  const out: WorktreeEntry[] = [];
  for (const name of names) {
    const path = join(worktreesRoot, name);
    const mtimeMs = await stat(path).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    const runId = /-(r_[^/]+)$/.exec(name)?.[1];
    out.push({ path, ...(runId ? { runId } : {}), mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Remove a worktree by path alone: a linked worktree's `.git` file names its git dir
 * (`<repo>/.git/worktrees/<name>`), which locates the repo. Falls back to deleting the
 * directory when the repo cannot be found (git metadata may then need a manual prune).
 * Returns false only when nothing could be removed.
 */
export async function removeWorktreeByPath(path: string): Promise<boolean> {
  try {
    const dotGit = await readFile(join(path, '.git'), 'utf8');
    const gitDir = /^gitdir: (.+)$/m.exec(dotGit.trim())?.[1];
    if (gitDir) {
      // <repo>/.git/worktrees/<name> -> <repo>
      await removeWorktree(resolve(gitDir, '..', '..', '..'), path);
      return true;
    }
  } catch {
    // Fall through to the plain delete below.
  }
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
