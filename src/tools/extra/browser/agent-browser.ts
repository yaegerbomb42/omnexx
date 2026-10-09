import { readFile, unlink } from 'node:fs/promises';
import { execa } from 'execa';
import type {
  BrowserBackend,
  BrowserConsoleMessage,
  BrowserRequest,
  BrowserTab,
  ScreenshotResult,
  WaitTarget,
} from './types.js';
import { describeWaitTarget, pollUntil } from './wait.js';

interface JsonResponse<T> {
  success: boolean;
  data?: T | null;
  error?: string | null;
}

interface ConsoleData {
  messages?: {
    type?: string;
    text?: string;
    args?: unknown[];
  }[];
  /** From `agent-browser errors --json`: uncaught page exceptions. */
  errors?: { text?: string }[];
}

interface RequestsData {
  requests?: {
    method?: string;
    url?: string;
    status?: number;
    resourceType?: string;
  }[];
}

interface TabsData {
  tabs?: { tabId?: string; url?: string; title?: string; active?: boolean }[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class AgentBrowserBackend implements BrowserBackend {
  readonly name = 'agent-browser';

  constructor(
    private readonly session: string,
    private readonly headless = true,
  ) {}

  private async runCli(args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<string> {
    const fullArgs = ['--session', this.session];
    if (!this.headless) {
      fullArgs.push('--headed');
    }
    fullArgs.push(...args);

    const result = await execa('agent-browser', fullArgs, {
      timeout,
      reject: false,
    });

    if (result.failed) {
      throw new Error(`agent-browser ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout;
  }

  /** Runs a command with `--json` and returns its `data`, throwing the CLI's own error message. */
  private async json<T>(args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<T> {
    const fullArgs = ['--session', this.session, '--json'];
    if (!this.headless) fullArgs.push('--headed');
    fullArgs.push(...args);
    const result = await execa('agent-browser', fullArgs, { timeout, reject: false });
    const parsed = parseJsonLine(result.stdout) as JsonResponse<T> | undefined;
    if (parsed && !parsed.success)
      throw new Error(parsed.error ?? `agent-browser ${args[0]} failed`);
    if (result.failed || !parsed) {
      throw new Error(`agent-browser ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return (parsed.data ?? {}) as T;
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
    await this.json(['click', this.formatTarget(ref)]);
  }

  async type(ref: string, text: string): Promise<void> {
    await this.json(['type', this.formatTarget(ref), text]);
  }

  async fill(ref: string, text: string): Promise<void> {
    await this.json(['fill', this.formatTarget(ref), text]);
  }

  async select(ref: string, value: string): Promise<void> {
    await this.json(['select', this.formatTarget(ref), value]);
  }

  async setChecked(ref: string, checked: boolean): Promise<void> {
    await this.json([checked ? 'check' : 'uncheck', this.formatTarget(ref)]);
  }

  async upload(ref: string, file: string): Promise<void> {
    await this.json(['upload', this.formatTarget(ref), file]);
  }

  async hover(ref: string): Promise<void> {
    await this.json(['hover', this.formatTarget(ref)]);
  }

  async press(key: string): Promise<void> {
    await this.runCli(['press', key]);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<void> {
    await this.runCli(['scroll', direction, String(amount)]);
  }

  async waitFor(target: WaitTarget, timeoutMs: number): Promise<void> {
    let check: () => Promise<boolean>;
    if ('text' in target) {
      const expr = `document.body.innerText.includes(${JSON.stringify(target.text)})`;
      check = async () => (await this.evaluate(expr)) === true;
    } else {
      const sel = this.formatTarget(target.selector);
      check = sel.startsWith('@')
        ? async () =>
            (await this.json<{ visible?: boolean }>(['is', 'visible', sel])).visible === true
        : async () => ((await this.json<{ count?: number }>(['get', 'count', sel])).count ?? 0) > 0;
    }
    await pollUntil(check, timeoutMs, describeWaitTarget(target));
  }

  async waitForLoad(timeoutMs: number): Promise<void> {
    await pollUntil(
      async () => (await this.evaluate('document.readyState')) === 'complete',
      timeoutMs,
      'the page to finish loading',
    );
  }

  async getText(ref: string): Promise<string> {
    return (await this.json<{ text?: string }>(['get', 'text', this.formatTarget(ref)])).text ?? '';
  }

  async getUrl(): Promise<string> {
    return (await this.json<{ url?: string }>(['get', 'url'])).url ?? '';
  }

  async evaluate(expression: string): Promise<unknown> {
    return (await this.json<{ result?: unknown }>(['eval', expression])).result;
  }

  async network(): Promise<BrowserRequest[]> {
    const data = await this.json<RequestsData>(['network', 'requests']);
    return (data.requests ?? []).map((r) => ({
      method: r.method ?? 'GET',
      url: r.url ?? '',
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.resourceType !== undefined ? { resourceType: r.resourceType } : {}),
    }));
  }

  async tabs(): Promise<BrowserTab[]> {
    const data = await this.json<TabsData>(['tab', 'list']);
    return (data.tabs ?? []).map((t) => ({
      id: t.tabId ?? '',
      url: t.url ?? '',
      title: t.title ?? '',
      active: t.active === true,
    }));
  }

  async switchTab(id: string): Promise<void> {
    await this.json(['tab', /^\d+$/.test(id) ? `t${id}` : id]);
  }

  async newTab(url: string): Promise<void> {
    await this.json(['tab', 'new', url]);
  }

  async closeTab(id?: string): Promise<void> {
    const ref = id === undefined ? [] : [/^\d+$/.test(id) ? `t${id}` : id];
    await this.json(['tab', 'close', ...ref]);
  }

  async screenshot(): Promise<ScreenshotResult> {
    const data = await this.json<{ path?: string }>(['screenshot']);
    const filePath = data.path;
    if (!filePath) {
      throw new Error('No screenshot path returned by agent-browser');
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
      this.json<ConsoleData>(['console']),
      this.json<ConsoleData>(['errors']).catch(() => undefined),
    ]);
    return [
      ...(logs.messages ?? []).map((m) => ({ type: m.type ?? 'log', text: m.text ?? '' })),
      ...(errors?.errors ?? []).map((e) => ({ type: 'error', text: e.text ?? 'page error' })),
    ];
  }

  async close(): Promise<void> {
    try {
      await this.runCli(['close']);
    } catch {
      // Ignore errors when closing an already closed session
    }
  }
}

function parseJsonLine(output: string): unknown {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{') && l.endsWith('}'));
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
