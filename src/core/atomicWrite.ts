import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Write `data` to `path` with verify-after-write atomic semantics: stage the
 * intended content to a sibling temp file, fsync it, verify its checksum
 * matches the intended content, then atomically rename it over the target. On
 * POSIX the parent directory is fsynced after the rename to persist the
 * directory entry. Resolves with the SHA-256 checksum of the written content.
 */
export async function writeFileAtomic(path: string, data: string): Promise<string> {
  const intended = sha256Hex(data);
  const dir = dirname(path);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }

  if (sha256Hex(await readFile(tmp, 'utf8')) !== intended) {
    await rm(tmp, { force: true });
    throw new Error('writeFileAtomic: checksum mismatch, temp file removed');
  }

  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  if (process.platform !== 'win32') {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  return intended;
}
