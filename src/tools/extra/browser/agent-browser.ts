import { readFile, unlink } from 'node:fs/promises';
import { execa } from 'execa';
import type { BrowserBackend, BrowserConsoleMessage, ScreenshotResult } from './types.js';

interface ConsoleJsonResponse {
  success: boolean;
  data?: {
    messages?: {
      type?: string;
      text?: string;
      args?: unknown[];
    }[];
    /** From `agent-browser errors --json`: uncaught page exceptions. */
    errors?: { text?: string }[];
  };
  error?: string | null;
}

interface ScreenshotJsonResponse {
  success: boolean;
  data?: {
    path?: string;
  };
  error?: string | null;
}

export class AgentBrowserBackend implements BrowserBackend {
  readonly name = 'agent-browser';

  constructor(
    private readonly session: string,
    private readonly headless = true,
  ) {}

  private async runCli(args: string[]): Promise<string> {
    const fullArgs = ['--session', this.session];
    if (!this.headless) {
      fullArgs.push('--headed');
    }
    fullArgs.push(...args);

    const result = await execa('agent-browser', fullArgs, {
      timeout: 30_000,
      reject: false,
    });

    if (result.failed) {
      throw new Error(`agent-browser ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout;
  }

  async open(url: string): Promise<void> {
    await this.runCli(['open', url]);
  }

  async snapshot(): Promise<string> {
    const output = await this.runCli(['snapshot']);
    // agent-browser often outputs a header like "✓ Example Domain \n https://..."
    return output.trim();
  }

  private formatTarget(refOrSelector: string): string {
    const s = refOrSelector.trim();
    if (s.startsWith('@')) {
      // If it's a generated snapshot ref like @e1 or @1, pass as-is
      if (/^@e?\d+$/.test(s)) return s;
      // If it's @element-id, map to CSS id selector #element-id
      return `#${s.slice(1)}`;
    }
    // If it's an id without # and without CSS symbols, map to #id if matching identifier
    if (/^[a-zA-Z0-9_-]+$/.test(s) && !s.startsWith('#') && !s.startsWith('.')) {
      if (/^e?\d+$/.test(s)) return `@${s}`;
      return `#${s}`;
    }
    return s;
  }

  async click(ref: string): Promise<void> {
    await this.runCli(['click', this.formatTarget(ref)]);
  }

  async type(ref: string, text: string): Promise<void> {
    await this.runCli(['fill', this.formatTarget(ref), text]);
  }

  async press(key: string): Promise<void> {
    await this.runCli(['press', key]);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<void> {
    await this.runCli(['scroll', direction, String(amount)]);
  }

  async screenshot(): Promise<ScreenshotResult> {
    const output = await this.runCli(['screenshot', '--json']);
    // Extract JSON line from output
    const jsonLine = output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{') && l.endsWith('}'));

    if (!jsonLine) {
      throw new Error(`Failed to parse screenshot JSON output from agent-browser: ${output}`);
    }

    const parsed = JSON.parse(jsonLine) as ScreenshotJsonResponse;
    const filePath = parsed.data?.path;
    if (!filePath) {
      throw new Error(`No screenshot path returned by agent-browser: ${output}`);
    }

    try {
      const buffer = await readFile(filePath);
      const base64 = buffer.toString('base64');
      return {
        base64,
        mimeType: 'image/png',
      };
    } finally {
      await unlink(filePath).catch(() => undefined);
    }
  }

  /** Console messages, plus uncaught page exceptions as `error` entries. */
  async console(): Promise<BrowserConsoleMessage[]> {
    const [logs, errors] = await Promise.all([
      this.jsonData(['console', '--json']),
      this.jsonData(['errors', '--json']).catch(() => undefined),
    ]);
    return [
      ...(logs?.messages ?? []).map((m) => ({ type: m.type ?? 'log', text: m.text ?? '' })),
      ...(errors?.errors ?? []).map((e) => ({ type: 'error', text: e.text ?? 'page error' })),
    ];
  }

  private async jsonData(args: string[]): Promise<ConsoleJsonResponse['data']> {
    const output = await this.runCli(args);
    const jsonLine = output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{') && l.endsWith('}'));
    if (!jsonLine) return undefined;
    try {
      return (JSON.parse(jsonLine) as ConsoleJsonResponse).data;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    try {
      await this.runCli(['close']);
    } catch {
      // Ignore errors when closing an already closed session
    }
  }
}
