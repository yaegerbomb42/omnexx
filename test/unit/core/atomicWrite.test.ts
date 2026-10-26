import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/core/atomicWrite.js';

const { corruptReads } = vi.hoisted(() => ({ corruptReads: { value: false } }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: vi.fn(async (p: string, encoding: BufferEncoding) => {
      if (corruptReads.value && encoding === 'utf8' && p.endsWith('.tmp')) {
        return 'TAMPERED';
      }
      return actual.readFile(p, encoding);
    }),
  };
});

describe('writeFileAtomic', () => {
  beforeEach(() => {
    corruptReads.value = false;
  });

  it('returns the checksum and writes the intended content atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomicwrite-'));
    const target = join(dir, 'out.txt');
    const content = 'hello world\n';
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');

    const returned = await writeFileAtomic(target, content);

    expect(returned).toBe(digest);
    expect(await readFile(target, 'utf8')).toBe(content);
    await rm(dir, { recursive: true, force: true });
  });

  it('throws on a checksum mismatch and leaves the target unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomicwrite-'));
    const target = join(dir, 'out.txt');
    await writeFile(target, 'preexisting content', 'utf8');

    corruptReads.value = true;

    await expect(writeFileAtomic(target, 'new content')).rejects.toThrow(/checksum/i);

    expect(await readFile(target, 'utf8')).toBe('preexisting content');
    await rm(dir, { recursive: true, force: true });
  });

  it('throws on a checksum mismatch and leaves no partial write when the target was absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomicwrite-'));
    const target = join(dir, 'out.txt');

    corruptReads.value = true;

    await expect(writeFileAtomic(target, 'new content')).rejects.toThrow(/checksum/i);

    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
    await rm(dir, { recursive: true, force: true });
  });
});
