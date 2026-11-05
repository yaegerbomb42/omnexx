import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../../src/git/git.js';
import { StateCheckpointer, pathsFromToolInput } from '../../../src/runtime/kernel/checkpoint.js';
import { rollbackConstraint } from '../../../src/runtime/kernel/types.js';
import { tempRepo } from '../../support/tmp.js';

describe('StateCheckpointer', () => {
  it('snapshots dirty files and restores them on rollback', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'a.ts'), ' console.log(1);\n');
    await git(repo, ['add', 'a.ts']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const cp = new StateCheckpointer({ worktree: repo });
    await writeFile(join(repo, 'a.ts'), 'console.log(2);\n');
    await writeFile(join(repo, 'b.ts'), 'export const x = 1;\n');

    const snap = await cp.snapshot('node-1', 4, ['a.ts', 'b.ts']);
    expect(snap.files['a.ts']).toContain('console.log(2)');
    expect(snap.files['b.ts']).toContain('export const x');

    await writeFile(join(repo, 'a.ts'), 'console.log(BROKEN);\n');
    await writeFile(join(repo, 'b.ts'), 'export const x = 99;\n');

    const result = await cp.rollbackToCheckpoint('node-1', 'tool errors thrice');
    expect(result.restored).toBe(true);
    expect(result.pruneAfter).toBe(4);
    expect(result.constraint).toContain('[KERNEL ROLLBACK]');
    expect(result.constraint).toContain('node-1');
    expect(await readFile(join(repo, 'a.ts'), 'utf8')).toContain('console.log(2)');
    expect(await readFile(join(repo, 'b.ts'), 'utf8')).toContain('export const x = 1');
    expect(cp.has('node-1')).toBe(false);
  });

  it('removes files that did not exist at snapshot time', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'keep.ts'), 'ok\n');
    await git(repo, ['add', 'keep.ts']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const cp = new StateCheckpointer({ worktree: repo });
    // Snapshot before new.ts exists → content ''
    await mkdir(join(repo, 'sub'), { recursive: true });
    const snap = await cp.snapshot('n2', 1, ['new.ts']);
    expect(snap.files['new.ts']).toBe('');

    await writeFile(join(repo, 'new.ts'), 'should vanish\n');
    const result = await cp.rollbackToCheckpoint('n2', 'bad write');
    expect(result.restored).toBe(true);
    await expect(readFile(join(repo, 'new.ts'), 'utf8')).rejects.toThrow();
  });

  it('returns a constraint even when the node is unknown', async () => {
    const repo = await tempRepo();
    const cp = new StateCheckpointer({ worktree: repo });
    const result = await cp.rollbackToCheckpoint('missing', 'unknown branch');
    expect(result.restored).toBe(false);
    expect(result.constraint).toBe(
      rollbackConstraint('missing', 'unknown branch', 'a different approach'),
    );
  });
});

describe('pathsFromToolInput', () => {
  it('extracts path fields from common tool shapes', () => {
    expect(pathsFromToolInput({ path: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(pathsFromToolInput({ files: ['a.ts', { path: 'b.ts' }] })).toEqual(['a.ts', 'b.ts']);
    expect(pathsFromToolInput({ edits: [{ path: 'c.ts' }] })).toEqual(['c.ts']);
  });
});
