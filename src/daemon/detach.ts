import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

/** argv prefix that runs this CLI again: `[node, /path/to/dist/cli.js]`. Tests substitute their own entry. */
export const selfEntry = (): string[] => [process.execPath, process.argv[1] ?? ''];

/**
 * Start `omnexx supervise <runId>` in its own session, stdio to supervisor.log, and let go:
 * closing the terminal or SSH session doesn't touch it (plan §5.2).
 */
export function spawnDetached(
  entry: readonly string[],
  args: readonly string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
): number {
  const [cmd, ...rest] = entry;
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(cmd ?? process.execPath, [...rest, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  child.unref();
  return child.pid ?? -1;
}

/** Run a supervisor as an attached child and resolve with its exit code (resume --all). */
export function spawnAttached(
  entry: readonly string[],
  args: readonly string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [cmd, ...rest] = entry;
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(cmd ?? process.execPath, [...rest, ...args], {
    stdio: ['ignore', fd, fd],
    env,
  });
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
    child.on('error', () => {
      resolve(1);
    });
  });
}
