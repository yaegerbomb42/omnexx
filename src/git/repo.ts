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

export const isClean = async (cwd: string): Promise<boolean> => (await statusPorcelain(cwd)) === '';

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
}

/**
 * Everything that differs between `base` and the working tree, untracked files included.
 * Uses a throwaway index so the real index is never touched.
 */
export async function workingTreeDiff(
  cwd: string,
  base: string,
): Promise<{ changes: FileChange[]; patch: string; treeHash: string }> {
  const env = {
    GIT_INDEX_FILE: `${(await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim()}/omnexx-index`,
  };
  const abs = env.GIT_INDEX_FILE.startsWith('/')
    ? env
    : { GIT_INDEX_FILE: `${cwd}/${env.GIT_INDEX_FILE}` };
  await git(cwd, ['read-tree', base], { env: abs });
  await git(cwd, ['add', '-A'], { env: abs });
  const treeHash = (await git(cwd, ['write-tree'], { env: abs })).stdout.trim();
  const patch = (await git(cwd, ['diff', '--cached', '--binary', '-M', base], { env: abs })).stdout;
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
