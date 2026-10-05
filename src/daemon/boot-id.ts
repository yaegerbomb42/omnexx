import { readFile } from 'node:fs/promises';
import { execa } from 'execa';

/**
 * An id that changes on every boot: a pid from before a reboot may be reused by an unrelated
 * process, so pid liveness alone can't tell a stale lock from a live one.
 */
export async function readBootId(): Promise<string> {
  if (process.platform === 'linux') {
    try {
      return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    } catch {
      // fall through
    }
  }
  if (process.platform === 'darwin') {
    const r = await execa('sysctl', ['-n', 'kern.bootsessionuuid'], {
      reject: false,
      stdin: 'ignore',
    });
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return 'unknown';
}
