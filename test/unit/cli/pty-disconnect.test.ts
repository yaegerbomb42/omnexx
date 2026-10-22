import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PtyDaemon, connectPty } from '../../../src/cli/pty.js';
import { tempDir } from '../../support/tmp.js';

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('PtyDaemon client disconnect', () => {
  it('unpipes and kills the shell when the client closes', async () => {
    const dir = await tempDir();
    const pidFile = join(dir, 'shell.pid');
    const daemon = new PtyDaemon({ shell: '/bin/sh' });
    const sockPath = await daemon.start();
    try {
      const client = await connectPty(sockPath);
      client.write(`echo $$ > '${pidFile}'; sleep 30\n`);
      const deadline = Date.now() + 2_000;
      let pid = 0;
      while (Date.now() < deadline) {
        try {
          pid = Number((await readFile(pidFile, 'utf8')).trim());
          if (pid > 0) break;
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(pid).toBeGreaterThan(0);
      expect(await alive(pid)).toBe(true);
      client.end();
      const goneBy = Date.now() + 2_000;
      while (Date.now() < goneBy && (await alive(pid))) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await alive(pid)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});
