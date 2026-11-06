import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { GitError } from '../errors.js';
import { git } from '../git/git.js';
import { resolveRef } from '../git/repo.js';

/**
 * Worktree manager for the 24/7 autonomous daemon.
 *
 * Every task runs in its own detached worktree under `.omnexx/worktrees/task-<id>` so the
 * user's primary working directory (HEAD, index, files) is never mutated. Progress is
 * checkpointed to `refs/omnexx/wip/<task-id>` via `commit-tree`, which likewise leaves the
 * worktree's HEAD and index alone (a throwaway index does the staging).
 */

export interface WorktreeInfo {
  taskId: string;
  path: string;
  baseSha: string;
}

export interface WorktreeListEntry {
  taskId: string;
  path: string;
  /** HEAD sha of the worktree, when it could be resolved. */
  head?: string | undefined;
  detached: boolean;
}

export interface WorktreeManagerOptions {
  /** Repo the daemon works on. */
  repoRoot: string;
  /** Defaults to `<repoRoot>/.omnexx/worktrees`. */
  worktreesRoot?: string;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw new GitError(`invalid task id: ${taskId}`);
}

export class WorktreeManager {
  readonly repoRoot: string;
  readonly worktreesRoot: string;

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.worktreesRoot = resolve(
      options.worktreesRoot ?? join(this.repoRoot, '.omnexx', 'worktrees'),
    );
  }

  /** Create the manager and prune stale worktrees left by crashed runs. */
  static async boot(options: WorktreeManagerOptions): Promise<WorktreeManager> {
    const manager = new WorktreeManager(options);
    await manager.pruneStale();
    return manager;
  }

  pathFor(taskId: string): string {
    assertTaskId(taskId);
    return join(this.worktreesRoot, `task-${taskId}`);
  }

  wipRef(taskId: string): string {
    assertTaskId(taskId);
    return `refs/omnexx/wip/${taskId}`;
  }

  /**
   * Create a detached worktree for `taskId` at `baseSha`. Creates
   * `.omnexx/worktrees/` when it does not exist.
   */
  async create(taskId: string, baseSha: string): Promise<WorktreeInfo> {
    assertTaskId(taskId);
    const base = await resolveRef(this.repoRoot, baseSha);
    const path = this.pathFor(taskId);
    await mkdir(this.worktreesRoot, { recursive: true });
    const r = await git(this.repoRoot, ['worktree', 'add', '--detach', path, base], {
      allowFailure: true,
    });
    if (r.exitCode !== 0) {
      throw new GitError(`cannot create worktree for ${taskId}: ${r.stderr.trim()}`);
    }
    return { taskId, path, baseSha: base };
  }

  /**
   * Commit the worktree's current changes (tracked + untracked) on its
   * detached HEAD, for shipping: the shipper pushes HEAD, so uncommitted
   * edits would never leave the machine. Returns the new commit sha.
   * Throws when there is nothing to commit.
   */
  async commit(taskId: string, message: string): Promise<string> {
    const path = this.pathFor(taskId);
    await git(path, ['add', '-A']);
    const r = await git(
      path,
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=omnexx',
        '-c',
        'user.email=omnexx@users.noreply.invalid',
        'commit',
        '-m',
        message,
      ],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new GitError(`worktree has no changes to commit for ${taskId}`);
    }
    return (await git(path, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  /**
   * Checkpoint the worktree's current state (tracked + untracked files) to
   * `refs/omnexx/wip/<task-id>` without touching the worktree's HEAD or index.
   * Returns the checkpoint commit sha.
   */
  async checkpoint(taskId: string, message?: string): Promise<string> {
    const path = this.pathFor(taskId);
    const ref = this.wipRef(taskId);
    const head = (await git(path, ['rev-parse', 'HEAD'], { allowFailure: true })).stdout.trim();
    // Throwaway index: stage the working tree (untracked included) without
    // racing the agent's own index use in this worktree.
    const gitDir = (await git(path, ['rev-parse', '--git-dir'])).stdout.trim();
    const absGitDir = gitDir.startsWith('/') ? gitDir : join(path, gitDir);
    const indexFile = join(absGitDir, `omnexx-wip-index-${taskId}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await git(path, ['read-tree', head || 'HEAD'], { env, allowFailure: true });
      await git(path, ['add', '-A'], { env });
      const tree = (await git(path, ['write-tree'], { env })).stdout.trim();
      const parent = head ? [head] : [];
      const commit = (
        await git(
          path,
          [
            '-c',
            'commit.gpgsign=false',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'user.name=omnexx',
            '-c',
            'user.email=omnexx@users.noreply.invalid',
            'commit-tree',
            tree,
            ...parent.flatMap((p) => ['-p', p]),
            '-m',
            message ?? `omnexx wip checkpoint for ${taskId}`,
          ],
          { env },
        )
      ).stdout.trim();
      await git(this.repoRoot, ['update-ref', ref, commit]);
      return commit;
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  /** Reset the worktree's files to the tree recorded by a checkpoint. */
  async resetToCheckpoint(taskId: string, treeHash: string): Promise<void> {
    const path = this.pathFor(taskId);
    if (!/^[0-9a-f]{40}$/.test(treeHash)) throw new GitError(`invalid tree hash: ${treeHash}`);
    await git(path, ['read-tree', treeHash]);
    await git(path, ['checkout-index', '-f', '-a']);
    // Drop files the checkpoint does not know about (tracked state is the tree's).
    await git(path, ['clean', '-fd', '-q'], { allowFailure: true });
  }

  /** Remove the worktree and its wip ref. */
  async destroy(taskId: string): Promise<void> {
    const path = this.pathFor(taskId);
    await git(this.repoRoot, ['worktree', 'remove', '--force', path], { allowFailure: true });
    await git(this.repoRoot, ['update-ref', '-d', this.wipRef(taskId)], { allowFailure: true });
    await rm(path, { recursive: true, force: true });
    await git(this.repoRoot, ['worktree', 'prune'], { allowFailure: true });
  }

  /** Worktrees under the daemon's root, parsed from `git worktree list --porcelain`. */
  async list(): Promise<WorktreeListEntry[]> {
    const out = await git(this.repoRoot, ['worktree', 'list', '--porcelain'], {
      allowFailure: true,
    });
    if (out.exitCode !== 0) return [];
    const entries: WorktreeListEntry[] = [];
    let current: { path?: string; head?: string; detached?: boolean } = {};
    const flush = (): void => {
      if (!current.path) return;
      const name = basename(current.path);
      const m = /^task-(.+)$/.exec(name);
      if (m && current.path.startsWith(this.worktreesRoot)) {
        entries.push({
          taskId: m[1] ?? '',
          path: current.path,
          ...(current.head ? { head: current.head } : {}),
          detached: current.detached ?? false,
        });
      }
      current = {};
    };
    for (const line of out.stdout.split('\n')) {
      if (line === '') {
        flush();
        continue;
      }
      if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
      else if (line === 'detached') current.detached = true;
    }
    flush();
    return entries;
  }

  /**
   * Prune stale worktrees: git's own prune plus any orphan directory under the
   * daemon root that git no longer knows about (crashed run, manual delete).
   */
  async pruneStale(): Promise<string[]> {
    await git(this.repoRoot, ['worktree', 'prune'], { allowFailure: true });
    const known = new Set((await this.list()).map((e) => resolve(e.path)));
    const removed: string[] = [];
    await mkdir(this.worktreesRoot, { recursive: true });
    const { readdir, stat } = await import('node:fs/promises');
    const names = await readdir(this.worktreesRoot).catch(() => null);
    if (names === null) return removed;
    for (const name of names) {
      if (!name.startsWith('task-')) continue;
      const path = join(this.worktreesRoot, name);
      if (known.has(resolve(path))) continue;
      const isDir = await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isDir) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
    return removed;
  }
}
