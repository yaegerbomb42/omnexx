import { spawn, type ChildProcess } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { registerChild, unregisterChild } from '../core/process-registry.js';

/** How much of a server's stderr is kept, for "why didn't it start?" messages and the Logs view. */
export const STDERR_TAIL_CHARS = 8_000;

export interface StdioServerParameters {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
}

/**
 * Clean native Node child_process transport for Stdio MCP clients.
 * Avoids cross-spawn's dynamic require('child_process') which fails under ESM bundles.
 */
export class NodeStdioClientTransport implements Transport {
  private _process?: ChildProcess | undefined;
  private readonly _readBuffer = new ReadBuffer();
  private readonly _params: StdioServerParameters;
  private _stderr = '';
  private _exit: string | undefined;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(params: StdioServerParameters) {
    this._params = params;
  }

  get pid(): number | null {
    return this._process?.pid ?? null;
  }

  /** The last few KB the server wrote to stderr (its log), plus how it exited, if it has. */
  get stderr(): string {
    return this._exit ? `${this._stderr}${this._stderr ? '\n' : ''}${this._exit}` : this._stderr;
  }

  async start(): Promise<void> {
    if (this._process) {
      throw new Error('NodeStdioClientTransport already started');
    }

    return new Promise((resolve, reject) => {
      // An allowlisted env must be used verbatim: merging process.env back in would hand every
      // host secret to the server. PATH is the only inherited extra, so bare commands still spawn.
      const env: NodeJS.ProcessEnv =
        this._params.env === undefined
          ? process.env
          : {
              ...this._params.env,
              ...(this._params.env.PATH === undefined && process.env.PATH !== undefined
                ? { PATH: process.env.PATH }
                : {}),
            };

      const child = spawn(this._params.command, this._params.args ?? [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        cwd: this._params.cwd,
      });

      this._process = child;
      if (child.pid !== undefined)
        // Not detached: it shares the supervisor's group, so register pgid = pid and the
        // group kill falls through to a direct kill of the server itself.
        registerChild({
          pid: child.pid,
          pgid: child.pid,
          kind: 'daemon',
          command: [this._params.command, ...(this._params.args ?? [])].join(' '),
          startedAt: Date.now(),
        });

      child.on('error', (err) => {
        reject(err);
        this.onerror?.(err);
      });

      child.on('spawn', () => {
        resolve();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        this._stderr = (this._stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });

      child.on('close', (code, signal) => {
        if (this._process === child && (code || signal))
          this._exit = `(exited with ${signal ? `signal ${signal}` : `code ${String(code)}`})`;
        this._process = undefined;
        if (child.pid !== undefined) unregisterChild(child.pid);
        this.onclose?.();
      });

      child.stdin.on('error', (err) => {
        this.onerror?.(err);
      });

      child.stdout.on('data', (chunk: Buffer) => {
        try {
          this._readBuffer.append(chunk);
          for (;;) {
            const message = this._readBuffer.readMessage();
            if (!message) break;
            this.onmessage?.(message);
          }
        } catch (err) {
          this.onerror?.(err as Error);
          void this.close();
        }
      });

      child.stdout.on('error', (err) => {
        this.onerror?.(err);
      });
    });
  }

  async close(): Promise<void> {
    if (this._process) {
      const proc = this._process;
      this._process = undefined;
      if (proc.pid !== undefined) unregisterChild(proc.pid);

      let closed = proc.exitCode !== null || proc.signalCode !== null;
      const closePromise = new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        proc.once('close', () => {
          closed = true;
          resolve();
        });
      });

      /** Wait for `close`, but never longer than `ms`; the timer must not keep the process alive. */
      const waitForClose = (ms: number): Promise<void> => {
        const timeout = new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref();
        });
        return Promise.race([closePromise, timeout]);
      };

      const alive = (): boolean => !closed && proc.exitCode === null && proc.signalCode === null;

      try {
        proc.stdin?.end();
      } catch {
        // ignore
      }

      await waitForClose(2000);

      if (alive()) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        await waitForClose(2000);
      }

      if (alive()) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        // A short grace period so close() resolves without leaving a zombie behind.
        await waitForClose(500);
      }
    }
    this._readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._process?.stdin) {
        reject(new Error('Not connected'));
        return;
      }
      const json = serializeMessage(message);
      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once('drain', () => {
          resolve();
        });
      }
    });
  }
}
