import { spawn, type ChildProcess } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(params: StdioServerParameters) {
    this._params = params;
  }

  get pid(): number | null {
    return this._process?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this._process) {
      throw new Error('NodeStdioClientTransport already started');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this._params.command, this._params.args ?? [], {
        env: this._params.env ? { ...process.env, ...this._params.env } : process.env,
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: false,
        cwd: this._params.cwd,
      });

      this._process = child;

      child.on('error', (err) => {
        reject(err);
        this.onerror?.(err);
      });

      child.on('spawn', () => {
        resolve();
      });

      child.on('close', () => {
        this._process = undefined;
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

      const closePromise = new Promise<void>((resolve) => {
        proc.once('close', () => {
          resolve();
        });
      });

      try {
        proc.stdin?.end();
      } catch {
        // ignore
      }

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, 2000).unref();
      });

      await Promise.race([closePromise, timeoutPromise]);

      if (proc.exitCode === null) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        await Promise.race([closePromise, timeoutPromise]);
      }

      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
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
