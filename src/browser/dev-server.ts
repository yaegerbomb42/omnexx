import { createServer, connect } from 'node:net';
import { execa } from 'execa';
import { killGroup } from '../core/exec.js';
import { registerChild, unregisterChild } from '../core/process-registry.js';

/**
 * A dev server owned by the browser tool: started on demand, health-checked on a port or URL,
 * with its recent output kept so a failed startup explains itself. The process runs in its own
 * group so a supervisor (vite, next, webpack) and its children stop together.
 */

export interface DevServerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Wait until this port accepts TCP connections. */
  port?: number | undefined;
  /** Or wait until this URL answers any HTTP status (useful when the app uses a proxy). */
  url?: string | undefined;
  /** Default 60s. */
  timeoutMs?: number;
  /** Run the server is registered under (for run-end cleanup and `omnexx ps`). */
  runId?: string | undefined;
  /**
   * When no port or URL is given, pick a free high port, hand it to the server via PORT, and
   * probe it. A user-supplied port (or serve_port) is always honored as-is.
   */
  autoPort?: boolean | undefined;
}

export interface DevServerStatus {
  running: boolean;
  command: string;
  port?: number;
  url?: string;
  startedAt?: number;
  exitCode?: number;
  /** Last 20k characters of stdout+stderr. */
  output: string;
}

const OUTPUT_TAIL = 20_000;
const POLL_MS = 250;

interface ChildHandle {
  pid: number | undefined;
  all: NodeJS.ReadableStream | null | undefined;
  completion: Promise<{ exitCode: number | undefined }>;
}

export class DevServer {
  private child: ChildHandle | undefined;
  private exited = false;
  private exitCode: number | undefined;
  private out = '';
  private startedAt: number | undefined;
  /** Port the server actually listens on: explicit, or auto-picked when `autoPort`. */
  private resolvedPort: number | undefined;

  constructor(private readonly opts: DevServerOptions) {}

  status(): DevServerStatus {
    return {
      running: this.child !== undefined && !this.exited,
      command: this.opts.command,
      ...(this.resolvedPort !== undefined ? { port: this.resolvedPort } : {}),
      ...(this.opts.url !== undefined ? { url: this.opts.url } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      output: this.out,
    };
  }

  /** Start the server and wait until it answers; throws with its output if it dies first. */
  async start(): Promise<DevServerStatus> {
    if (this.child && !this.exited) return this.status();
    this.exited = false;
    this.exitCode = undefined;
    this.out = '';
    this.startedAt = Date.now();

    // No port given: pick a free high one and hand it to the server via PORT, so vite/next/
    // serve bind above 10000 by default instead of 3000/5173/8080. The reservation is held
    // only until the child is spawned: it cannot bind while the reservation listens.
    let reserved: ReservedPort | undefined;
    let port = this.opts.port;
    if (port === undefined && this.opts.autoPort === true && this.opts.url === undefined) {
      reserved = await pickHighPort();
      port = reserved.port;
    }
    this.resolvedPort = port;

    const childEnv =
      port !== undefined
        ? {
            ...(this.opts.env ?? process.env),
            PORT: this.opts.env?.PORT ?? String(port),
          }
        : this.opts.env;
    const child = execa(this.opts.command, {
      shell: '/bin/sh',
      cwd: this.opts.cwd,
      ...(childEnv ? { env: childEnv, extendEnv: false } : {}),
      detached: true,
      all: true,
      reject: false,
      stdin: 'ignore',
    });
    await reserved?.release();
    const handle: ChildHandle = {
      pid: child.pid,
      all: child.all,
      completion: child.then((result) => ({ exitCode: result.exitCode })),
    };
    this.child = handle;
    if (child.pid !== undefined)
      registerChild(
        {
          pid: child.pid,
          pgid: child.pid,
          kind: 'server',
          command: this.opts.command,
          ...(port !== undefined ? { port } : {}),
          startedAt: this.startedAt,
        },
        this.opts.runId,
      );
    child.all.on('data', (data: Buffer) => {
      this.out = (this.out + data.toString()).slice(-OUTPUT_TAIL);
    });
    void handle.completion.then((result) => {
      this.exited = true;
      this.exitCode = result.exitCode;
      if (child.pid !== undefined) unregisterChild(child.pid, this.opts.runId);
    });

    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    try {
      while (port !== undefined || this.opts.url !== undefined) {
        if (this.hasExited()) {
          throw new Error(
            `dev server exited with code ${this.exitLabel()} before it was ready:\n${this.out.trim()}`,
          );
        }
        if (await this.answers()) return this.status();
        if (Date.now() >= deadline) {
          throw new Error(
            `dev server did not answer${port !== undefined ? ` on port ${String(port)}` : ''} within ${String(timeoutMs)}ms:\n${this.out.trim()}`,
          );
        }
        await delay(POLL_MS);
      }
      // No port or URL to probe: give it a moment to crash on an obvious error.
      await delay(750);
      if (this.hasExited()) {
        throw new Error(`dev server exited with code ${this.exitLabel()}:\n${this.out.trim()}`);
      }
      return this.status();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.hasExited() && child.pid !== undefined) {
      killGroup(child.pid, 'SIGTERM');
      await Promise.race([child.completion.catch(() => undefined), delay(2_000)]);
      if (!this.hasExited()) killGroup(child.pid, 'SIGKILL');
      await Promise.race([child.completion.catch(() => undefined), delay(1_000)]);
    }
    if (child.pid !== undefined) unregisterChild(child.pid, this.opts.runId);
    this.child = undefined;
    this.exited = false;
    this.exitCode = undefined;
    this.startedAt = undefined;
    this.resolvedPort = undefined;
  }

  /** Indirection keeps lint from assuming the process state cannot change across awaits. */
  private hasExited(): boolean {
    return this.exited;
  }

  private exitLabel(): string {
    return this.exitCode === undefined ? '?' : String(this.exitCode);
  }

  private async answers(): Promise<boolean> {
    if (this.opts.url) {
      try {
        await fetch(this.opts.url, { signal: AbortSignal.timeout(1_000) });
        return true;
      } catch {
        return false;
      }
    }
    if (this.resolvedPort !== undefined) return portOpen(this.resolvedPort);
    return false;
  }
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    socket.setTimeout(500);
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => {
      done(true);
    });
    socket.once('timeout', () => {
      done(false);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/** A localhost port kept reserved until the caller releases it. */
export interface ReservedPort {
  port: number;
  /**
   * Stop reserving the port. Call after the consumer has bound to it so the
   * port is never left unreserved before the consumer can take it.
   */
  release: () => Promise<void>;
}

/**
 * Reserve a free localhost port, picked by the OS. The reservation stays
 * listening until `release()` is called, so another process cannot grab the
 * port between discovery and the consumer binding to it (the server is closed
 * only after the consumer binds, not before the promise resolves).
 */
export function freePort(): Promise<ReservedPort> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    let released: Promise<void> | undefined;
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        release: () => {
          released ??= new Promise<void>((closeResolve) => {
            server.close(() => {
              closeResolve();
            });
          });
          return released;
        },
      });
    });
  });
}

/** Dev servers bind high by default: never 3000/5173/8080 unless the user asked for it. */
export const MIN_HIGH_PORT = 10_000;

/** A free localhost port at or above `MIN_HIGH_PORT`, held until the caller releases it. */
export async function pickHighPort(minPort: number = MIN_HIGH_PORT): Promise<ReservedPort> {
  let held: ReservedPort | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const reserved = await freePort();
    if (reserved.port >= minPort) {
      await held?.release();
      return reserved;
    }
    await held?.release();
    held = reserved;
  }
  // Ephemeral ranges are normally high already; if the OS keeps handing out low ports, take
  // the last pick (still held) rather than failing the server start.
  return held ?? (await freePort());
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
