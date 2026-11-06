import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateCheckpointer } from '../../../src/runtime/kernel/checkpoint.js';

describe('bug #9: oversized/binary files are reported, not silently mis-restored', () => {
  it('skips large and binary files and names them in the rollback constraint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-ckpt-'));
    await writeFile(join(dir, 'small.txt'), 'v1');
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(2048));
    await writeFile(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    const c = new StateCheckpointer({ worktree: dir, maxFileBytes: 1024 });
    const rec = await c.snapshot('n1', 2, ['small.txt', 'big.txt', 'bin.dat']);
    expect(rec.skipped.sort()).toEqual(['big.txt', 'bin.dat']);
    expect(Object.keys(rec.files)).toContain('small.txt');
    expect(Object.keys(rec.files)).not.toContain('big.txt');

    await writeFile(join(dir, 'small.txt'), 'v2');
    const rb = await c.rollbackToCheckpoint('n1', 'broke it');
    expect(await readFile(join(dir, 'small.txt'), 'utf8')).toBe('v1');
    expect(rb.skipped.sort()).toEqual(['big.txt', 'bin.dat']);
    expect(rb.constraint).toContain('not restored');
  });
});
