import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import { engine } from './engine.js';

/** What `omnexx chat-server` prints, one JSON object per line. */
export type ServerMessage = { type: string } & Record<string, unknown>;

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const STDERR_TAIL_CHARS = 2_000;

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

  constructor(private readonly cwd: string | undefined) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  /** Starting resolves which omnexx to run first; commands sent meanwhile wait for it. */
  private starting: Promise<void> | undefined;

  start(): void {
    if (this.child || this.starting) return;
    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
  }

  private async launch(): Promise<void> {
    if (this.child) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.crashes.length >= MAX_RESTARTS) {
      this.emitter.fire({
        type: 'down',
        message: 'omnexx keeps exiting. Check `omnexx doctor` in a terminal, then use Restart.',
      });
      return;
    }
    this.buffer = '';
    this.stderr = '';
    let e: Awaited<ReturnType<typeof engine>>;
    try {
      e = await engine();
    } catch (err) {
      this.emitter.fire({
        type: 'down',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // A Windows .cmd shim only runs through a shell; the only argument is a fixed word.
    const child = spawn(e.command, [...e.prefix, 'chat-server'], {
      cwd: this.cwd,
      env: e.env,
      shell: e.shell,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.child = undefined;
      this.emitter.fire({
        type: 'down',
        message:
          err.code === 'ENOENT'
            ? 'omnexx is not installed or not on PATH. Install it with: npm i -g omnexx (or brew install yaegerbomb42/omnexx/omnexx), or set omnexx.path.'
            : `omnexx could not start: ${err.message}`,
      });
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.crashes.push(Date.now());
      const why = this.stderr.trim().split('\n').at(-1) ?? '';
      const exit = code === null ? '' : ` (exit ${String(code)})`;
      const reason = why ? `: ${why}` : '';
      this.emitter.fire({
        type: 'down',
        message: `omnexx stopped${exit}${reason}. It restarts with your next message.`,
      });
    });
  }

  send(cmd: Record<string, unknown>): void {
    const line = `${JSON.stringify(cmd)}\n`;
    if (this.child) {
      this.child.stdin.write(line);
      return;
    }
    this.start();
    void this.starting?.then(() => this.child?.stdin.write(line));
  }

  restart(): void {
    this.crashes = [];
    this.stop();
    this.start();
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    child?.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
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
    this.stop();
    this.emitter.dispose();
  }
}
