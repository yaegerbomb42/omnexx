import type {
  BrowserBackend,
  BrowserConsoleMessage,
  BrowserRequest,
  BrowserTab,
  ScreenshotResult,
  WaitTarget,
} from './types.js';

interface PlaywrightLocator {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  pressSequentially(text: string): Promise<void>;
  selectOption(value: string | { label: string }): Promise<string[]>;
  setChecked(checked: boolean): Promise<void>;
  setInputFiles(file: string): Promise<void>;
  hover(): Promise<void>;
  innerText(): Promise<string>;
  first(): PlaywrightLocator;
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
}

interface PlaywrightResponse {
  status(): number;
  url(): string;
  request(): { method(): string; resourceType(): string };
}

interface PlaywrightPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): PlaywrightLocator;
  getByText(text: string): PlaywrightLocator;
  keyboard: {
    press(key: string): Promise<void>;
  };
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  screenshot(options?: { type?: 'png' | 'jpeg' }): Promise<Buffer>;
  content(): Promise<string>;
  url(): string;
  title(): Promise<string>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  evaluate<R>(fn: (() => R) | string): Promise<R>;
  on(event: 'console', listener: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', listener: (err: Error) => void): void;
  on(event: 'response', listener: (res: PlaywrightResponse) => void): void;
  on(
    event: 'requestfailed',
    listener: (req: { method(): string; url(): string; resourceType(): string }) => void,
  ): void;
  on(event: 'close', listener: () => void): void;
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  on(event: 'page', listener: (page: PlaywrightPage) => void): void;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightCoreModule {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}

/** Recent requests kept for `network`; older ones are dropped. */
const MAX_REQUESTS = 200;

export class PlaywrightBackend implements BrowserBackend {
  readonly name = 'playwright';
  private browser: PlaywrightBrowser | null = null;
  private context: PlaywrightBrowserContext | null = null;
  private page: PlaywrightPage | null = null;
  /** Open pages in opening order; index + 1 is the tab id. */
  private readonly pages: PlaywrightPage[] = [];
  private readonly consoleLogs: BrowserConsoleMessage[] = [];
  private readonly requests: BrowserRequest[] = [];

  constructor(private readonly headless = true) {}

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page;

    let pw: PlaywrightCoreModule;
    try {
      // Dynamic import of playwright-core as optional peer dependency
      // @ts-expect-error dynamic import of optional peer dependency
      pw = (await import('playwright-core')) as PlaywrightCoreModule;
    } catch (importErr) {
      throw new Error(
        'playwright-core is not installed. Run `npm install -D playwright-core` or install agent-browser to enable the browser tool.',
        { cause: importErr },
      );
    }

    try {
      this.browser = await pw.chromium.launch({ headless: this.headless });
      const context = await this.browser.newContext();
      this.context = context;
      // Pages opened by the app (target=_blank, window.open) become the active tab, as in
      // agent-browser.
      context.on('page', (p) => {
        this.track(p);
        this.page = p;
      });
      const first = await context.newPage();
      if (!this.pages.includes(first)) this.track(first);
      this.page = first;
      return first;
    } catch (err) {
      await this.close();
      throw new Error(
        `Failed to launch Playwright browser: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private track(page: PlaywrightPage): void {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    page.on('console', (msg) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
      });
    });
    // Uncaught exceptions never reach the console listener; report them as errors too.
    page.on('pageerror', (err) => {
      this.consoleLogs.push({ type: 'error', text: err.message });
    });
    page.on('response', (res) => {
      this.record({
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        resourceType: res.request().resourceType(),
      });
    });
    page.on('requestfailed', (req) => {
      this.record({ method: req.method(), url: req.url(), resourceType: req.resourceType() });
    });
    page.on('close', () => {
      const i = this.pages.indexOf(page);
      if (i >= 0) this.pages.splice(i, 1);
      if (this.page === page) this.page = this.pages.at(-1) ?? null;
    });
  }

  private record(r: BrowserRequest): void {
    this.requests.push(r);
    if (this.requests.length > MAX_REQUESTS) this.requests.shift();
  }

  private toSelector(ref: string): string {
    return ref.startsWith('@') ? `[data-ref="${ref.slice(1)}"], #${ref.slice(1)}` : ref;
  }

  private async loc(ref: string): Promise<PlaywrightLocator> {
    const page = await this.ensurePage();
    return page.locator(this.toSelector(ref)).first();
  }

  async open(url: string): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(url, { timeout: 30_000 });
  }

  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    // Build an accessibility tree summary / simplified DOM representation
    const snapshotScript = `(() => {
      function walk(node, depth = 0) {
        const indent = '  '.repeat(depth);
        if (node.nodeType === 3) { // TEXT_NODE
          const text = (node.textContent || '').trim();
          return text ? [indent + 'StaticText "' + text + '"'] : [];
        }
        if (node.nodeType === 1) { // ELEMENT_NODE
          const el = node;
          const tag = el.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style') return [];
          const role = el.getAttribute('role') || tag;
          const id = el.id ? '#' + el.id : '';
          const ariaLabel = el.getAttribute('aria-label');
          const ref = el.getAttribute('data-ref') || el.id || '';
          const refAttr = ref ? ' [ref=' + ref + ']' : '';
          const nameAttr = ariaLabel ? ' "' + ariaLabel + '"' : '';

          const lines = [indent + '- ' + role + nameAttr + id + refAttr];
          for (let i = 0; i < el.childNodes.length; i++) {
            const childNode = el.childNodes[i];
            if (childNode) {
              lines.push(...walk(childNode, depth + 1));
            }
          }
          return lines;
        }
        return [];
      }
      return walk(document.body).join('\\n');
    })()`;

    return page.evaluate<string>(snapshotScript);
  }

  async click(ref: string): Promise<void> {
    await (await this.loc(ref)).click();
  }

  async type(ref: string, text: string): Promise<void> {
    await (await this.loc(ref)).pressSequentially(text);
  }

  async fill(ref: string, text: string): Promise<void> {
    await (await this.loc(ref)).fill(text);
  }

  async select(ref: string, value: string): Promise<void> {
    const l = await this.loc(ref);
    // A value that matches no option is treated as the option's visible label.
    try {
      await l.selectOption(value);
    } catch {
      await l.selectOption({ label: value });
    }
  }

  async setChecked(ref: string, checked: boolean): Promise<void> {
    await (await this.loc(ref)).setChecked(checked);
  }

  async upload(ref: string, file: string): Promise<void> {
    await (await this.loc(ref)).setInputFiles(file);
  }

  async hover(ref: string): Promise<void> {
    await (await this.loc(ref)).hover();
  }

  async press(key: string): Promise<void> {
    const page = await this.ensurePage();
    await page.keyboard.press(key);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<void> {
    const page = await this.ensurePage();
    let deltaX = 0;
    let deltaY = 0;
    if (direction === 'down') deltaY = amount;
    else if (direction === 'up') deltaY = -amount;
    else if (direction === 'right') deltaX = amount;
    else deltaX = -amount;

    await page.mouse.wheel(deltaX, deltaY);
  }

  async waitFor(target: WaitTarget, timeoutMs: number): Promise<void> {
    const page = await this.ensurePage();
    const l =
      'text' in target
        ? page.getByText(target.text).first()
        : page.locator(this.toSelector(target.selector)).first();
    await l.waitFor({ state: 'visible', timeout: timeoutMs });
  }

  async waitForLoad(timeoutMs: number): Promise<void> {
    const page = await this.ensurePage();
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  }

  async getText(ref: string): Promise<string> {
    return (await this.loc(ref)).innerText();
  }

  async getUrl(): Promise<string> {
    return (await this.ensurePage()).url();
  }

  async evaluate(expression: string): Promise<unknown> {
    return (await this.ensurePage()).evaluate<unknown>(expression);
  }

  async network(): Promise<BrowserRequest[]> {
    await this.ensurePage();
    return [...this.requests];
  }

  async tabs(): Promise<BrowserTab[]> {
    await this.ensurePage();
    return Promise.all(
      this.pages.map(async (p, i) => ({
        id: String(i + 1),
        url: p.url(),
        title: await p.title().catch(() => ''),
        active: p === this.page,
      })),
    );
  }

  private pageById(id: string): PlaywrightPage {
    const p = this.pages[Number(id.replace(/^t/, '')) - 1];
    if (!p) throw new Error(`no tab "${id}"; list tabs to see the open ones`);
    return p;
  }

  async switchTab(id: string): Promise<void> {
    await this.ensurePage();
    const p = this.pageById(id);
    await p.bringToFront();
    this.page = p;
  }

  async newTab(url: string): Promise<void> {
    await this.ensurePage();
    if (!this.context) throw new Error('browser context is gone');
    const p = await this.context.newPage();
    this.track(p);
    this.page = p;
    await p.goto(url, { timeout: 30_000 });
  }

  async closeTab(id?: string): Promise<void> {
    const p = id === undefined ? await this.ensurePage() : this.pageById(id);
    await p.close();
  }

  async screenshot(): Promise<ScreenshotResult> {
    const page = await this.ensurePage();
    const buffer = await page.screenshot({ type: 'png' });
    return {
      base64: buffer.toString('base64'),
      mimeType: 'image/png',
    };
  }

  async console(): Promise<BrowserConsoleMessage[]> {
    await this.ensurePage();
    return [...this.consoleLogs];
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.context = null;
      this.page = null;
      this.pages.length = 0;
    }
  }
}
