import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitCheckpoint, tagCheckpoint } from '../../../src/git/checkpoint.js';
import { git } from '../../../src/git/git.js';
import {
  blobAt,
  commitMessage,
  hashWorkingFile,
  headSha,
  isAncestor,
  isClean,
  statusPorcelain,
  workingTreeDiff,
} from '../../../src/git/repo.js';
import { rollbackTo } from '../../../src/git/rollback.js';
import { formatTrailers, parseTrailers } from '../../../src/git/trailers.js';
import { createWorktree, removeWorktree } from '../../../src/git/worktree.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

async function seeded(): Promise<string> {
  const repo = await tempRepo();
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  return repo;
}

describe('trailers', () => {
  it('round-trips, with and without worker', () => {
    const t = { run: 'r_1', task: 'M1.T01', cycle: 3 };
    expect(parseTrailers(`subj\n\nbody\n\n${formatTrailers(t)}\n`)).toEqual(t);
    expect(parseTrailers(formatTrailers({ ...t, worker: 'fake' }))).toEqual({
      ...t,
      worker: 'fake',
    });
    expect(parseTrailers('Omnexx-Run: r\nOmnexx-Task: t\n')).toBeUndefined();
    expect(parseTrailers('Omnexx-Run: r\nOmnexx-Task: t\nOmnexx-Cycle: x')).toBeUndefined();
  });
});

describe('worktree + checkpoint + rollback', () => {
  it('never touches the user checkout, commits with trailers, rolls back byte-identically', async () => {
    const repo = await seeded();
    await writeFile(join(repo, 'dirty.txt'), 'user work in progress\n');
    const before = { head: await headSha(repo), status: await statusPorcelain(repo) };
    const wtRoot = await tempDir();
    const wt = await createWorktree(repo, wtRoot, 'r_20261003_0000_abcd');
    expect(wt.branch).toBe('omnexx/r_20261003_0000_abcd');
    expect(wt.startRef).toBe(before.head);
    expect(await isClean(wt.path)).toBe(true);

    await writeFile(join(wt.path, 'a.txt'), 'two\n');
    await writeFile(join(wt.path, 'new.txt'), 'new\n');
    const diff = await workingTreeDiff(wt.path, wt.startRef);
    expect(diff.changes.map((c) => [c.status, c.path]).sort()).toEqual([
      ['A', 'new.txt'],
      ['M', 'a.txt'],
    ]);
    expect(diff.patch).toContain('+two');
    expect(await statusPorcelain(wt.path)).not.toBe(''); // the real index was not used

    const sha = await commitCheckpoint(wt.path, 'omnexx(M1.T01): change a', 'body', {
      run: 'r',
      task: 'M1.T01',
      cycle: 1,
    });
    expect(await isClean(wt.path)).toBe(true);
    expect(parseTrailers(await commitMessage(wt.path, sha))).toEqual({
      run: 'r',
      task: 'M1.T01',
      cycle: 1,
    });
    expect(await isAncestor(wt.path, wt.startRef, sha)).toBe(true);
    expect(await blobAt(wt.path, sha, 'new.txt')).toBe(await hashWorkingFile(wt.path, 'new.txt'));
    expect(await blobAt(wt.path, wt.startRef, 'new.txt')).toBeUndefined();
    await tagCheckpoint(wt.path, 'omnexx/r/M1', sha);
    expect((await git(repo, ['tag', '--list', 'omnexx/*'])).stdout).toContain('omnexx/r/M1');

    await writeFile(join(wt.path, 'a.txt'), 'broken\n');
    await writeFile(join(wt.path, 'junk.txt'), 'junk\n');
    const patchPath = join(await tempDir(), 'rejected.patch');
    expect((await rollbackTo(wt.path, sha, { path: patchPath, redact: (x) => x })).savedPatch).toBe(
      true,
    );
    expect(await readFile(patchPath, 'utf8')).toContain('+broken');
    expect(await isClean(wt.path)).toBe(true);
    expect(await readFile(join(wt.path, 'a.txt'), 'utf8')).toBe('two\n');
    expect((await rollbackTo(wt.path, sha, { path: patchPath, redact: (x) => x })).savedPatch).toBe(
      false,
    );

    expect({ head: await headSha(repo), status: await statusPorcelain(repo) }).toEqual(before);
    await removeWorktree(repo, wt.path);
  });

  it('commits with a fallback identity when none is configured', async () => {
    const repo = await seeded();
    await git(repo, ['config', '--unset', 'user.email']);
    await writeFile(join(repo, 'b.txt'), 'b\n');
    const env = { HOME: await tempDir(), XDG_CONFIG_HOME: await tempDir() };
    const prev = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
    Object.assign(process.env, {
      HOME: env.HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      GIT_CONFIG_NOSYSTEM: '1',
    });
    try {
      const sha = await commitCheckpoint(repo, 's', '', { run: 'r', task: 't', cycle: 1 });
      expect((await git(repo, ['log', '-1', '--format=%ae', sha])).stdout).toBe(
        'omnexx@users.noreply.invalid',
      );
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev.XDG;
      delete process.env.GIT_CONFIG_NOSYSTEM;
    }
  });

  it('createWorktree fails clearly when the branch exists', async () => {
    const repo = await seeded();
    const root = await tempDir();
    await createWorktree(repo, root, 'r_20261003_0000_aaaa');
    await expect(createWorktree(repo, await tempDir(), 'r_20261003_0000_aaaa')).rejects.toThrow(
      /cannot create worktree/,
    );
  });
});

describe('sanitizePatch', () => {
  it('drops credential files and redacts the rest', async () => {
    const { sanitizePatch } = await import('../../../src/git/rollback.js');
    const patch =
      'diff --git a/.env b/.env\n+KEY=abc\ndiff --git a/src/a.ts b/src/a.ts\n+const t = "SECRET";\n';
    const out = sanitizePatch(patch, (s) => s.replace('SECRET', '[R]'));
    expect(out).not.toContain('KEY=abc');
    expect(out).toContain('+const t = "[R]";');
  });
});
