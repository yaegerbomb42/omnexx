import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { execa } from 'execa';
import { killGroup } from '../core/exec.js';

/** A free localhost port, picked by the OS. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

/** Whether package.json in `cwd` declares `script`. */
export async function hasNpmScript(cwd: string, script: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.[script] === 'string';
  } catch {
    return false;
  }
}

export interface Served {
  /** Output so far (for the gate log when startup fails). */
  output: () => string;
  stop: () => Promise<void>;
}

/**
 * Start `command` in its own process group and wait until `url` answers any HTTP status.
 * Throws with the server's output if it exits first or `timeoutMs` passes.
 */
export async function serveUntilReady(
  command: string,
  opts: {
    cwd: string;
    env: Record<string, string>;
    url: string;
    timeoutMs: number;
    fetch?: typeof fetch;
  },
): Promise<Served> {
  const child = execa(command, {
    shell: '/bin/sh',
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    detached: true,
    all: true,
    reject: false,
    stdin: 'ignore',
  });
  let out = '';
  child.all.on('data', (d: Buffer) => {
    out = (out + d.toString()).slice(-20_000);
  });
  const state = { exited: false };
  void child.then(() => {
    state.exited = true;
  });
  const stop = async (): Promise<void> => {
    if (child.pid !== undefined && !state.exited) {
      killGroup(child.pid, 'SIGTERM');
      const t = setTimeout(() => {
        if (child.pid !== undefined && !state.exited) killGroup(child.pid, 'SIGKILL');
      }, 3_000);
      await child.catch(() => undefined);
      clearTimeout(t);
    }
  };
  const fetchFn = opts.fetch ?? fetch;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`server exited before ${opts.url} answered:\n${out.trim()}`);
    try {
      await fetchFn(opts.url, { signal: AbortSignal.timeout(1_000) });
      return { output: () => out, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await stop();
  throw new Error(`nothing answered at ${opts.url} within ${opts.timeoutMs}ms:\n${out.trim()}`);
}
