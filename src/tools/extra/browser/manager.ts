import net from 'node:net';
import { type ChildProcess, spawn } from 'node:child_process';
import type { BrowserConfig } from '../../../config/sections/browser.js';
import { parseDuration } from '../../../config/duration.js';
import type { BrowserBackend } from './types.js';
import { createBrowserBackend } from './detector.js';

export interface BrowserManagerOptions {
  runId: string;
  config: BrowserConfig;
  worktreeRoot: string;
}

export class BrowserSessionManager {
  private backend: BrowserBackend | null = null;
  private devServerProcess: ChildProcess | null = null;
  private devServerStarted = false;

  constructor(private readonly options: BrowserManagerOptions) {}

  async getBackend(): Promise<BrowserBackend> {
    if (!this.backend) {
      const sessionName = `omnexx-${this.options.runId}`;
      const backend = await createBrowserBackend(sessionName, this.options.config.headless);
      if (!backend) {
        throw new Error('No browser backend available (agent-browser or playwright-core).');
      }
      this.backend = backend;
    }
    return this.backend;
  }

  async ensureDevServerForUrl(urlStr: string): Promise<void> {
    const { serve, serve_port, serve_timeout } = this.options.config;
    if (!serve || !serve_port || this.devServerStarted) {
      return;
    }

    try {
      const parsed = new URL(urlStr);
      const isLocal =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname.endsWith('.local');
      if (!isLocal) return;

      // Start dev server
      this.devServerStarted = true;
      const child = spawn(serve, {
        cwd: this.options.worktreeRoot,
        shell: true,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      this.devServerProcess = child;

      // Wait for port
      const timeoutMs = parseDuration(serve_timeout);
      await waitForPort(serve_port, timeoutMs);
    } catch (err) {
      this.devServerStarted = false;
      throw new Error(
        `Failed to start dev server "${serve}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async close(): Promise<void> {
    if (this.backend) {
      await this.backend.close().catch(() => undefined);
      this.backend = null;
    }

    if (this.devServerProcess?.pid) {
      try {
        // Kill dev server process tree if possible
        process.kill(-this.devServerProcess.pid, 'SIGKILL');
      } catch {
        try {
          this.devServerProcess.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      this.devServerProcess = null;
      this.devServerStarted = false;
    }
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const isUp = await checkPort(port);
    if (isUp) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}
