import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { git } from './git.js';

export const headSha = async (cwd: string): Promise<string> =>
  (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

export const resolveRef = async (cwd: string, ref: string): Promise<string> =>
  (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
}

/** Porcelain status including untracked files. Empty string = clean. */
export async function statusPorcelain(cwd: string): Promise<string> {
  return (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
}

/** Where test runners write coverage reports by default (vitest, jest, c8, nyc). */
const COVERAGE_OUTPUT = [':(glob)coverage/**', ':(glob)**/.nyc_output/**'];

/**
 * `git add -A`, minus coverage reports a test run wrote that `base` doesn't track (`vitest
 * --coverage` writes one on every gate run). They are tool output, not work: committed, they churn
 * on every run and look like changes. Files the repo already tracks stage as usual.
 */
export async function stageAll(
  cwd: string,
  base: string,
  env?: Record<string, string>,
): Promise<void> {
  const opts = env ? { env } : {};
  await git(cwd, ['add', '-A'], opts);
  const added = (
    await git(
      cwd,
      ['diff', '--cached', '--name-only', '--diff-filter=A', '-z', base, '--', ...COVERAGE_OUTPUT],
      opts,
    )
  ).stdout
    .split('\0')
    .filter(Boolean);
  if (!added.length) return;
  await git(
    cwd,
    [
      'rm',
      '-r',
      '--cached',
      '--quiet',
      '--ignore-unmatch',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ],
    { ...opts, input: added.join('\0') },
  );
}

export const isClean = async (cwd: string): Promise<boolean> => (await statusPorcelain(cwd)) === '';

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
}

/** Absolute path of the throwaway index file `index` in the repo's git dir. */
async function indexEnv(cwd: string, index: string): Promise<{ GIT_INDEX_FILE: string }> {
  const file = `${(await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim()}/${index}`;
  return { GIT_INDEX_FILE: file.startsWith('/') ? file : `${cwd}/${file}` };
}

/** Stage the working tree (untracked files included) into a throwaway index; its tree id. */
async function stageTree(
  cwd: string,
  base: string,
  env: { GIT_INDEX_FILE: string },
): Promise<string> {
  await git(cwd, ['read-tree', base], { env });
  await stageAll(cwd, base, env);
  return (await git(cwd, ['write-tree'], { env })).stdout.trim();
}

/**
 * Tree id of the working tree, as `workingTreeDiff` reports it, through its own throwaway index:
 * speculative checks hash the tree in the background while a diff may be taken.
 */
export async function workingTreeHash(cwd: string, base: string): Promise<string> {
  // An index per call: two hashes at once would fight over one index's lock file.
  const env = await indexEnv(cwd, `omnexx-spec-index-${randomUUID()}`);
  try {
    return await stageTree(cwd, base, env);
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}

/**
 * Paths that differ between `base` and the working tree and still exist, untracked files
 * included. Safe beside `workingTreeDiff`: it shares no index with it.
 */
export async function changedPaths(cwd: string, base: string): Promise<string[]> {
  const tree = await workingTreeHash(cwd, base);
  const out = await git(cwd, ['diff-tree', '-r', '--name-only', '--diff-filter=d', base, tree]);
  return out.stdout.split('\n').filter(Boolean);
}

/**
 * Everything that differs between `base` and the working tree, untracked files included.
 * Uses a throwaway index so the real index is never touched.
 */
export async function workingTreeDiff(
  cwd: string,
  base: string,
): Promise<{ changes: FileChange[]; patch: string; treeHash: string }> {
  // An index per call: two diffs at once would fight over one index's lock file.
  const abs = await indexEnv(cwd, `omnexx-index-${randomUUID()}`);
  try {
    const treeHash = await stageTree(cwd, base, abs);
    const raw = (await git(cwd, ['diff', '--cached', '--binary', '-M', base], { env: abs })).stdout;
    // The git wrapper strips the final newline; `git apply` needs it back.
    const patch = raw && !raw.endsWith('\n') ? `${raw}\n` : raw;
    const status = (await git(cwd, ['diff', '--cached', '--name-status', '-M', base], { env: abs }))
      .stdout;
    const numstat = (await git(cwd, ['diff', '--cached', '--numstat', '-M', base], { env: abs }))
      .stdout;
    const counts = numstat
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, r] = l.split('\t');
        return { added: Number(a) || 0, removed: Number(r) || 0 };
      });
    const changes = status
      .split('\n')
      .filter(Boolean)
      .map((line, i): FileChange => {
        const [code = 'M', p1 = '', p2] = line.split('\t');
        const c = counts[i] ?? { added: 0, removed: 0 };
        if (code.startsWith('R')) return { status: 'R', oldPath: p1, path: p2 ?? p1, ...c };
        return { status: code.charAt(0) as FileChange['status'], path: p1, ...c };
      });
    return { changes, patch, treeHash };
  } finally {
    await rm(abs.GIT_INDEX_FILE, { force: true });
  }
}

/** Blob id of `path` at `ref`, or undefined when the file doesn't exist there. */
export async function blobAt(cwd: string, ref: string, path: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}:${path}`], {
    allowFailure: true,
  });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

export async function hashWorkingFile(cwd: string, path: string): Promise<string | undefined> {
  const r = await git(cwd, ['hash-object', '--', path], { allowFailure: true });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

export async function commitMessage(cwd: string, sha: string): Promise<string> {
  return (await git(cwd, ['log', '-1', '--format=%B', sha])).stdout;
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (
    (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }))
      .exitCode === 0
  );
}
