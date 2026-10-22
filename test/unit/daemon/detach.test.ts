import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnAttached, spawnDetached } from '../../../src/daemon/detach.js';
import { tempDir } from '../../support/tmp.js';

async function fdCount(): Promise<number> {
  return (await readdir(`/dev/fd`)).length;
}

describe('daemon spawn log fds', () => {
  it('closes the parent copy after spawnAttached so repeated launches do not leak fds', async () => {
    const dir = await tempDir();
    const log = join(dir, 'supervisor.log');
    const before = await fdCount();
    for (let i = 0; i < 15; i++) {
      const code = await spawnAttached(
        [process.execPath, '-e'],
        ['process.exit(0)'],
        log,
        process.env,
      );
      expect(code).toBe(0);
    }
    const after = await fdCount();
    expect(after - before).toBeLessThan(5);
  });

  it('closes the parent copy after spawnDetached', async () => {
    const dir = await tempDir();
    const log = join(dir, 'd.log');
    const before = await fdCount();
    for (let i = 0; i < 15; i++) {
      const pid = spawnDetached([process.execPath, '-e'], ['process.exit(0)'], log, process.env);
      expect(pid).toBeGreaterThan(0);
    }
    await new Promise((r) => setTimeout(r, 50));
    const after = await fdCount();
    expect(after - before).toBeLessThan(5);
  });
});
