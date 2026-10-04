import { writeFile } from 'node:fs/promises';
import { execa } from 'execa';

export interface ExecResult {
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  /** stdout and stderr interleaved, as a human would have seen them. */
  output: string;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Full untrimmed output is written here (after redaction by the caller's `redact`). */
  logPath?: string;
  redact?: (s: string) => string;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL of the process group. */
  killGraceMs?: number;
  stdin?: string;
}

/** Kill an entire process group. Ignores "no such process". */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH: already gone. EPERM: macOS reports it for a group whose members are exiting zombies.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw err;
  }
}

/**
 * Run a shell command in its own process group, so a timeout or abort kills the whole tree
 * (test runners and harnesses love to spawn children). The model never waits on this: the
 * harness blocks here and spends zero tokens until the command ends (plan §4.4).
 */
export async function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const child = execa(command, {
    shell: '/bin/sh',
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    detached: true,
    all: true,
    reject: false,
    stripFinalNewline: false,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.stdin !== undefined ? { input: opts.stdin } : { stdin: 'ignore' }),
  });
  let timedOut = false;
  let aborted = false;
  const grace = opts.killGraceMs ?? 5_000;
  const stop = (): void => {
    if (child.pid === undefined) return;
    const pid = child.pid;
    killGroup(pid, 'SIGTERM');
    setTimeout(() => {
      killGroup(pid, 'SIGKILL');
    }, grace).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const result = await child;
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  // Kill anything the command left running in its group (background jobs, watchers).
  if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
  const raw = typeof result.all === 'string' ? result.all : '';
  const output = opts.redact ? opts.redact(raw) : raw;
  if (opts.logPath) await writeFile(opts.logPath, output, { mode: 0o600 });
  return {
    exitCode: result.exitCode ?? 124,
    timedOut,
    aborted,
    output,
    durationMs: Date.now() - started,
  };
}
