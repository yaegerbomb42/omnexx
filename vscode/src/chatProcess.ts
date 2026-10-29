import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import { engine } from './engine.js';

/** What `omnexx chat-server` prints, one JSON object per line. */
export type ServerMessage = { type: string } & Record<string, unknown>;

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const STDERR_TAIL_CHARS = 2_000;
const KILL_GRACE_MS = 2_000;
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024;

/**
 * One `omnexx chat-server` per workspace. Lines it prints become `onMessage` events; it restarts
 * on the next command after a crash, but gives up after a few crashes a minute.
 */
export class ChatProcess implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private stderr = '';
  private crashes: number[] = [];
  private readonly emitter = new vscode.EventEmitter<ServerMessage>();
  readonly onMessage = this.emitter.event;
  /** Bumps on stop/dispose so an in-flight `engine()` lookup cannot spawn after teardown. */
  private generation = 0;
  private disposed = false;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(private readonly cwd: string | undefined) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  /** Starting resolves which omnexx to run first; commands sent meanwhile wait for it. */
  private starting: Promise<void> | undefined;

  start(): void {
    if (this.disposed || this.child || this.starting) return;
    const generation = this.generation;
    this.starting = this.launch(generation).finally(() => {
      this.starting = undefined;
    });
  }

  /** True while stop/dispose has not invalidated this launch. */
  private stillCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async launch(generation: number): Promise<void> {
    if (this.child || !this.stillCurrent(generation)) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.crashes.length >= MAX_RESTARTS) {
      this.emitter.fire({
        type: 'down',
        message: 'omnexx keeps exiting. Check `omnexx doctor` in a terminal, then use Restart.',
      });
      this.notifyNotSent();
      return;
    }
    this.buffer = '';
    this.stderr = '';
    let e: Awaited<ReturnType<typeof engine>>;
    try {
      e = await engine();
    } catch (err) {
      if (!this.stillCurrent(generation)) return;
      this.emitter.fire({
        type: 'down',
        message: err instanceof Error ? err.message : String(err),
      });
      this.notifyNotSent();
      return;
    }
    if (!this.stillCurrent(generation)) return;
    // A Windows .cmd shim only runs through a shell; the only argument is a fixed word.
    const child = spawn(e.command, [...e.prefix, 'chat-server'], {
      cwd: this.cwd,
      env: lazyToolDiscovery() ? e.env : { ...e.env, OMNEXX_TOOL_DISCOVERY: 'full' },
      shell: e.shell,
      windowsHide: true,
      // A detached child leads its own process group, so we can kill its whole tree with
      // process.kill(-pid, ...) on POSIX. On Windows this would open a console window; taskkill
      // /T handles the tree there instead.
      detached: process.platform !== 'win32',
    });
    if (!this.stillCurrent(generation)) {
      this.killTree(child, 'SIGKILL');
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('spawn', () => {
      if (this.child === child) this.flushPending();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.emitter.fire({
        type: 'down',
        message:
          err.code === 'ENOENT'
            ? 'omnexx is not installed or not on PATH. Install it with: npm i -g omnexx (or brew install yaegerbomb42/omnexx/omnexx), or set omnexx.path.'
            : `omnexx could not start: ${err.message}`,
      });
      this.notifyNotSent();
    });
    child.on('exit', () => {
      this.clearKillTimer();
      if (this.child !== child) return;
      this.child = undefined;
      this.crashes.push(Date.now());
      const why = this.stderr.trim().split('\n').at(-1) ?? '';
      const exit = child.exitCode === null ? '' : ` (exit ${String(child.exitCode)})`;
      const reason = why ? `: ${why}` : '';
      this.emitter.fire({
        type: 'down',
        message: `omnexx stopped${exit}${reason}. It restarts with your next message.`,
      });
    });
  }

  send(cmd: Record<string, unknown>): void {
    const line = `${JSON.stringify(cmd)}\n`;
    if (this.child && this.writeStdin(line)) return;
    // No server (or one that is exiting): hold the line and flush it once a fresh launch succeeds.
    this.pending.push(line);
    this.start();
  }

  restart(): void {
    if (this.disposed) return;
    this.crashes = [];
    const pending = this.starting;
    this.stop();
    if (pending) {
      void pending.finally(() => {
        this.start();
      });
    } else this.start();
  }

  /** Lines that could not be written yet; flushed after the next successful launch. */
  private pending: string[] = [];

  /** Writes one line; false means the line was not accepted and should stay queued. */
  private writeStdin(line: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(line);
      return true;
    } catch {
      // EPIPE while the process is exiting; keep the line for the next launch.
      return false;
    }
  }

  private flushPending(): void {
    if (!this.child || this.pending.length === 0) return;
    this.pending = this.pending.filter((line) => !this.writeStdin(line));
  }

  /** A launch failed while lines were waiting; tell the user instead of dropping them. */
  private notifyNotSent(): void {
    if (this.pending.length === 0) return;
    this.emitter.fire({
      type: 'error',
      message: 'not sent — server is down',
    });
  }

  private stop(): void {
    this.generation += 1;
    this.clearKillTimer();
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    this.killTree(child, 'SIGTERM');
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      this.killTree(child, 'SIGKILL');
    }, KILL_GRACE_MS);
  }

  private killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      const args = ['/pid', String(pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
      return;
    }
    try {
      // The child is detached, so -pid is its whole process group: grandchildren die with it.
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }

  private clearKillTimer(): void {
    if (!this.killTimer) return;
    clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER) {
      this.buffer = '';
      this.emitter.fire({
        type: 'error',
        message: 'omnexx sent a line too large to parse; some output was dropped.',
      });
      return;
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emitter.fire(JSON.parse(line) as ServerMessage);
      } catch {
        // A stray non-JSON line (a warning printed by a dependency) is not a protocol message.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.emitter.dispose();
  }
}

/** `omnexx.lazyToolDiscovery` (default on). Off forces `[tools] discovery = "full"` for chats. */
function lazyToolDiscovery(): boolean {
  return vscode.workspace.getConfiguration('omnexx').get<boolean>('lazyToolDiscovery') ?? true;
}
