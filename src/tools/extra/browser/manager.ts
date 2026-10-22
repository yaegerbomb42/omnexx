import type { BrowserConfig } from '../../../config/sections/browser.js';
import { parseDuration } from '../../../config/duration.js';
import {
  collectBrowserDiagnostics,
  hasDiagnostics,
  type BrowserDiagnostics,
} from '../../../browser/diagnostics.js';
import { DevServer, type DevServerStatus } from '../../../browser/dev-server.js';
import type { BrowserBackend, BrowserLaunch } from './types.js';
import { createBrowserBackend } from './detector.js';

export interface BrowserManagerOptions {
  runId: string;
  config: BrowserConfig;
  worktreeRoot: string;
  /** Tests inject a fake; default: detect agent-browser or playwright-core. */
  createBackend?: (
    session: string,
    headless: boolean,
    launch: Partial<BrowserLaunch>,
  ) => Promise<BrowserBackend | null>;
  /** Tests inject a fake dev server. */
  createDevServer?: (command: string, port: number | undefined) => DevServerLike;
}

/** The part of DevServer the manager uses; tests can fake it without spawning. */
export interface DevServerLike {
  start(): Promise<DevServerStatus>;
  stop(): Promise<void>;
  status(): DevServerStatus;
}

export class BrowserSessionManager {
  private backend: BrowserBackend | null = null;
  private devServer: DevServerLike | null = null;
  private devServerStarted = false;
  /** How much of the backend's console/request buffers was reported already. */
  private consoleSeen = 0;
  private requestSeen = 0;

  constructor(private readonly options: BrowserManagerOptions) {}

  async getBackend(): Promise<BrowserBackend> {
    if (!this.backend) {
      const sessionName = `omnexx-${this.options.runId}`;
      const create = this.options.createBackend ?? createBrowserBackend;
      const { headless, engine, profile, session_name } = this.options.config;
      const backend = await create(sessionName, headless, {
        engine,
        ...(profile ? { profile } : {}),
        ...(session_name ? { sessionName: session_name } : {}),
      });
      if (!backend) {
        throw new Error('No browser backend available (agent-browser or playwright-core).');
      }
      this.backend = backend;
    }
    return this.backend;
  }

  /** Start the configured dev server when a local URL is opened (if one is configured). */
  async ensureDevServerForUrl(urlStr: string): Promise<void> {
    const { serve, serve_port } = this.options.config;
    if (!serve || !serve_port || this.devServerStarted) return;
    if (!isLocalUrl(urlStr)) return;
    await this.startDevServer(serve, serve_port);
  }

  /** Start a dev server, replacing one this session already owns. */
  async startDevServer(command: string, port?: number): Promise<DevServerStatus> {
    if (this.devServer?.status().running) {
      const current = this.devServer.status();
      if (current.command === command && current.port === port) return current;
      await this.stopDevServer();
    }
    const timeoutMs = parseDuration(this.options.config.serve_timeout);
    const server = this.options.createDevServer
      ? this.options.createDevServer(command, port)
      : new DevServer({
          command,
          port,
          cwd: this.options.worktreeRoot,
          timeoutMs,
        });
    this.devServer = server;
    this.devServerStarted = true;
    try {
      return await server.start();
    } catch (err) {
      this.devServer = null;
      this.devServerStarted = false;
      throw err;
    }
  }

  async stopDevServer(): Promise<void> {
    const server = this.devServer;
    this.devServer = null;
    this.devServerStarted = false;
    await server?.stop();
  }

  devServerStatus(): DevServerStatus | null {
    return this.devServer?.status() ?? null;
  }

  /**
   * Problems that appeared since the last call: console errors/exceptions and failed requests.
   * Cursors advance even when the action that followed found nothing, so each issue is reported
   * once. A `clear` resets them.
   */
  async newDiagnostics(): Promise<BrowserDiagnostics | null> {
    const backend = await this.getBackend();
    const [allConsole, allRequests] = await Promise.all([
      backend.console().catch(() => []),
      backend.network ? backend.network().catch(() => []) : Promise.resolve([]),
    ]);
    // Buffers can be cleared or wrap; a smaller length means start over.
    if (allConsole.length < this.consoleSeen) this.consoleSeen = 0;
    if (allRequests.length < this.requestSeen) this.requestSeen = 0;
    const freshConsole = allConsole.slice(this.consoleSeen);
    const freshRequests = allRequests.slice(this.requestSeen);
    this.consoleSeen = allConsole.length;
    this.requestSeen = allRequests.length;
    const d = collectBrowserDiagnostics({ console: freshConsole, requests: freshRequests });
    return hasDiagnostics(d) ? d : null;
  }

  /** Forget buffered messages when the page is replaced, so old pages don't poison a new one. */
  async resetDiagnostics(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    await backend.clearConsole?.().catch(() => undefined);
    await backend.clearNetwork?.().catch(() => undefined);
    this.consoleSeen = 0;
    this.requestSeen = 0;
  }

  /** After an explicit console clear, report the buffer from its start again. */
  forgetConsole(): void {
    this.consoleSeen = 0;
  }

  /** After an explicit network clear, report the buffer from its start again. */
  forgetNetwork(): void {
    this.requestSeen = 0;
  }

  async close(): Promise<void> {
    if (this.backend) {
      await this.backend.close().catch(() => undefined);
      this.backend = null;
    }
    this.consoleSeen = 0;
    this.requestSeen = 0;
    await this.stopDevServer();
  }
}

export function isLocalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}
