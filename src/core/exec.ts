import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

export type SessionName = 'main' | 'test' | 'repl' | (string & {});

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Full untrimmed output is written here (after redaction by the caller's `redact`). */
  logPath?: string;
  redact?: (s: string) => string;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL of the process group. */
  killGraceMs?: number;
  stdin?: string;
  /** Extra cleanup when the command is timed out or aborted (e.g. kill it inside a container). */
  onKill?: () => Promise<void>;
  /** Named persistent shell session ('main' | 'test' | 'repl'). Omit or set oneShot for disposable run. */
  session?: SessionName;
  /** Force-reset the named session before running the command. */
  resetSession?: boolean;
  /** Force a disposable one-shot subshell instead of a persistent session. */
  oneShot?: boolean;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  aborted?: boolean;
  durationMs: number;
  cwd?: string;
  session?: string;
}

/** Runs one shell command and waits for it: on the host, or inside the run's sandbox. */
export type Executor = (command: string, opts: ExecOptions) => Promise<ExecResult>;

/** Kill an entire process group. Ignores "no such process". */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw err;
  }
}

export interface ArgvResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a program (no shell) in its own process group with a wall-clock limit; on timeout the
 * whole tree gets SIGTERM, then SIGKILL after a grace period. Used for worker backends.
 */
export async function runArgv(
  argv: readonly string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    killGraceMs?: number;
    stdin?: string;
    redact: (s: string) => string;
    stdoutPath: string;
    stderrPath: string;
  },
): Promise<ArgvResult> {
  const [file, ...args] = argv;
  const started = Date.now();
  const child = execa(file ?? 'false', args, {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    detached: true,
    reject: false,
    stripFinalNewline: false,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.stdin !== undefined ? { input: opts.stdin } : { stdin: 'ignore' }),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid === undefined) return;
    const pid = child.pid;
    killGroup(pid, 'SIGTERM');
    setTimeout(() => {
      killGroup(pid, 'SIGKILL');
    }, opts.killGraceMs ?? 5_000).unref();
  }, opts.timeoutMs);
  const r = await child;
  clearTimeout(timer);
  if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
  const stdout = opts.redact(typeof r.stdout === 'string' ? r.stdout : '');
  const stderr = opts.redact(typeof r.stderr === 'string' ? r.stderr : '');
  await writeFile(opts.stdoutPath, stdout, { mode: 0o600 });
  await writeFile(opts.stderrPath, stderr, { mode: 0o600 });
  return {
    exitCode: r.exitCode ?? 124,
    timedOut,
    stdout,
    stderr,
    durationMs: Date.now() - started,
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 180;
const STATE_DIR = join(tmpdir(), 'omnexx-sessions');

/** Fast pre-flight syntax check using `bash -n` so unmatched quotes never wedge a persistent session in PS2. */
function checkBashSyntax(command: string, stdin?: string): Promise<string | null> {
  if (stdin !== undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile('/bin/bash', ['-n'], { timeout: 250 }, (err, _stdout, stderr) => {
      if (err && stderr.trim()) {
        resolve(stderr.trim());
      } else {
        resolve(null);
      }
    });
    child.on('error', () => { resolve(null); });
    child.stdin?.end(command);
  });
}

/** Kill all direct and indirect child processes of `parentPid` without killing `parentPid` itself. */
function killChildTree(parentPid: number, sig: 'TERM' | 'KILL'): Promise<void> {
  return new Promise((resolve) => {
    execFile('pkill', [`-${sig}`, '-P', String(parentPid)], { timeout: 300 }, () => {
      resolve();
    });
  });
}

/**
 * A single persistent, stateful bash process (SWE-ReX style) that preserves `cwd`,
 * virtualenvs (`source .venv/bin/activate`), shell functions, and exported env vars across turns.
 */
export class ShellSession {
  readonly name: string;
  readonly rootCwd: string;
  private baseEnv: Record<string, string>;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lastCwd: string;
  private readonly cwdStatePath: string;
  private readonly envStatePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(name: string, rootCwd: string, baseEnv: Record<string, string>) {
    this.name = name;
    this.rootCwd = rootCwd;
    this.lastCwd = rootCwd;
    this.baseEnv = { ...baseEnv };
    mkdirSync(STATE_DIR, { recursive: true });
    const safeId = `${Buffer.from(rootCwd).toString('base64url').slice(0, 16)}-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    this.cwdStatePath = join(STATE_DIR, `${safeId}.cwd`);
    this.envStatePath = join(STATE_DIR, `${safeId}.env`);
  }

  get cwd(): string {
    return this.lastCwd;
  }

  /** Serialize command execution within the same named session so sentinel markers never interleave. */
  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const next = this.queue.then(
      () => this.runSerialized(command, opts),
      () => this.runSerialized(command, opts),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Hard-reset the persistent process and wipe saved state back to `rootCwd`. */
  reset(newEnv?: Record<string, string>): void {
    this.killProcessGroup();
    this.lastCwd = this.rootCwd;
    if (newEnv) this.baseEnv = { ...newEnv };
    try {
      rmSync(this.cwdStatePath, { force: true });
      rmSync(this.envStatePath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  dispose(): void {
    this.reset();
  }

  private killProcessGroup(): void {
    const p = this.proc;
    this.proc = null;
    if (!p?.pid) return;
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      try {
        p.kill('SIGKILL');
      } catch {
        // already exited
      }
    }
  }

  private ensureProcess(envOverride?: Record<string, string>): ChildProcessWithoutNullStreams {
    if (this.proc?.exitCode === null && !this.proc.killed) {
      return this.proc;
    }
    const mergedEnv: Record<string, string> = {
      ...process.env,
      ...this.baseEnv,
      ...(envOverride ?? {}),
      PS1: '',
      PS2: '',
      PROMPT_COMMAND: '',
      TERM: 'dumb',
    };
    const shellBin = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const args = shellBin.endsWith('bash') ? ['--norc', '--noprofile'] : [];
    const spawnCwd = existsSync(this.lastCwd) ? this.lastCwd : this.rootCwd;

    const proc = spawn(shellBin, args, {
      cwd: spawnCwd,
      env: mergedEnv,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Redirect session-level stderr to stdout so all subsequent output shares a single FIFO buffer.
    const bootstrapLines: string[] = ['exec 2>&1'];
    if (existsSync(this.envStatePath)) {
      bootstrapLines.push(`. "${this.envStatePath}" >/dev/null 2>&1 || true`);
    }
    if (existsSync(this.cwdStatePath)) {
      try {
        const savedCwd = readFileSync(this.cwdStatePath, 'utf8').trim();
        if (savedCwd && existsSync(savedCwd)) {
          this.lastCwd = savedCwd;
          bootstrapLines.push(`cd "${savedCwd.replace(/"/g, '\\"')}" >/dev/null 2>&1 || true`);
        }
      } catch {
        // fallback to spawnCwd
      }
    }
    proc.stdin.write(`${bootstrapLines.join('\n')}\n`);
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });
    proc.on('error', () => {
      if (this.proc === proc) this.proc = null;
    });

    this.proc = proc;
    return proc;
  }

  private async runSerialized(command: string, opts: ExecOptions): Promise<ExecResult> {
    const startMs = performance.now();
    if (opts.resetSession) {
      this.reset(opts.env);
    }

    // Guard against unmatched quotes / syntax errors that would leave the persistent shell in PS2.
    const syntaxErr = await checkBashSyntax(command, opts.stdin);
    if (syntaxErr) {
      const output = opts.redact ? opts.redact(syntaxErr) : syntaxErr;
      if (opts.logPath) {
        await writeLogSafe(opts.logPath, output);
      }
      return {
        output,
        exitCode: 2,
        timedOut: false,
        durationMs: performance.now() - startMs,
        cwd: this.lastCwd,
        session: this.name,
      };
    }

    const proc = this.ensureProcess(opts.env);
    const nonce = randomUUID().replace(/-/g, '');
    const sentinelPrefix = `__OMNEXX_DONE_${nonce}__`;
    const eofToken = `__OMNEXX_EOF_${nonce}__`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Frame the command with an internal heredoc if `opts.stdin` was extracted by `splitHeredoc`.
    const framedCommand =
      opts.stdin !== undefined
        ? `{\n${command}\n} <<'${eofToken}' 2>&1\n${opts.stdin.endsWith('\n') ? opts.stdin : `${opts.stdin}\n`}${eofToken}`
        : `{\n${command}\n} 2>&1`;

    const payload = [
      framedCommand,
      '__omnexx_ec=$?',
      `pwd -P > "${this.cwdStatePath}" 2>/dev/null || true`,
      `export -p > "${this.envStatePath}" 2>/dev/null || true`,
      `printf '\\n${sentinelPrefix}:%d:%s\\n' "$__omnexx_ec" "$PWD"`,
      '',
    ].join('\n');

    return new Promise<ExecResult>((resolve) => {
      let rawBuffer = '';
      let timedOut = false;
      let settled = false;
      let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

      const sentinelRegex = new RegExp(
        `(?:^|\\n)${sentinelPrefix}:(\\d+):([^\\r\\n]*)\\r?\\n?`,
      );

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        proc.off('exit', onExit);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      const finalize = async (exitCode: number, finalOutput: string, newCwd?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (newCwd?.startsWith('/')) {
          this.lastCwd = newCwd;
          try {
            writeFileSync(this.cwdStatePath, `${newCwd}\n`, 'utf8');
          } catch {
            // ignore
          }
        }
        const cleaned = opts.redact ? opts.redact(finalOutput) : finalOutput;
        if (opts.logPath) {
          await writeLogSafe(opts.logPath, cleaned);
        }
        resolve({
          output: cleaned,
          exitCode,
          timedOut,
          durationMs: performance.now() - startMs,
          cwd: this.lastCwd,
          session: this.name,
        });
      };

      const onData = (chunk: Buffer) => {
        rawBuffer += chunk.toString('utf8');
        const match = sentinelRegex.exec(rawBuffer);
        if (match) {
          const exitCode = Number(match[1] ?? 1);
          const pwd = match[2]?.trim();
          const beforeSentinel = rawBuffer.slice(0, match.index);
          void finalize(exitCode, beforeSentinel, pwd);
        }
      };

      const onExit = (code: number | null) => {
        this.proc = null;
        const stripped = rawBuffer.replace(sentinelRegex, '');
        void finalize(code ?? (timedOut ? 124 : 1), stripped);
      };

      const interruptCommand = () => {
        timedOut = true;
        if (!proc.pid) {
          void finalize(124, rawBuffer);
          return;
        }
        // Stage 1: Reap child processes of the shell so the shell itself survives and emits its sentinel.
        void killChildTree(proc.pid, 'TERM');
        setTimeout(() => {
          if (!settled && proc.pid) void killChildTree(proc.pid, 'KILL');
        }, 80);

        // Stage 2: If the shell itself is wedged after KILL_GRACE_MS, kill the process group and respawn next turn.
        killEscalationTimer = setTimeout(() => {
          if (!settled) {
            this.killProcessGroup();
            void finalize(124, rawBuffer);
          }
        }, KILL_GRACE_MS);
      };

      const onAbort = () => { interruptCommand(); };

      const timeoutTimer = setTimeout(interruptCommand, timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) {
          interruptCommand();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('exit', onExit);
      proc.stdin.write(payload);
    });
  }
}

/** Per-workspace pool of named persistent sessions ('main', 'test', 'repl'). */
export class SessionPool {
  private readonly sessions = new Map<string, ShellSession>();

  private key(rootCwd: string, sessionName: string): string {
    return `${rootCwd}::${sessionName}`;
  }

  getOrCreate(rootCwd: string, sessionName: SessionName, baseEnv: Record<string, string>): ShellSession {
    const k = this.key(rootCwd, sessionName);
    let session = this.sessions.get(k);
    if (!session) {
      session = new ShellSession(sessionName, rootCwd, baseEnv);
      this.sessions.set(k, session);
    }
    return session;
  }

  reset(rootCwd: string, sessionName?: SessionName): void {
    if (sessionName) {
      const s = this.sessions.get(this.key(rootCwd, sessionName));
      s?.reset();
      return;
    }
    for (const [k, s] of this.sessions.entries()) {
      if (k.startsWith(`${rootCwd}::`)) s.reset();
    }
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}

export const defaultSessionPool = new SessionPool();

async function writeLogSafe(logPath: string, content: string): Promise<void> {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    await writeFile(logPath, content, 'utf8');
  } catch {
    // non-fatal log write failure
  }
}

/** Disposable one-shot execution for isolated commands or when `opts.oneShot` is set. */
export async function runOneShotShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  const startMs = performance.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shellBin = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(shellBin, ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let settled = false;

    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = () => {
      timedOut = true;
      killGroup();
    };

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const onChunk = (c: Buffer) => {
      output += c.toString('utf8');
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }

    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const cleaned = opts.redact ? opts.redact(output) : output;
      if (opts.logPath) await writeLogSafe(opts.logPath, cleaned);
      resolve({
        output: cleaned,
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: performance.now() - startMs,
        cwd: opts.cwd,
      });
    };

    child.once('close', (code) => void finish(code));
    child.once('error', () => void finish(1));
  });
}

/**
 * Primary shell execution entrypoint.
 * Routes to a persistent named session ('main' by default) unless `opts.oneShot` is true.
 * Preserves 100% reference equality (`ctx.exec === runShell`) for `onHost(ctx)` checks.
 */
export async function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  if (opts.oneShot) {
    return runOneShotShell(command, opts);
  }
  const sessionName: SessionName = opts.session ?? 'main';
  const session = defaultSessionPool.getOrCreate(opts.cwd, sessionName, opts.env ?? {});
  return session.exec(command, opts);
}
