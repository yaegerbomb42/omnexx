import type { BrowserBackend, BrowserConsoleMessage, ScreenshotResult } from './types.js';

interface PlaywrightPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): {
    click(): Promise<void>;
    fill(text: string): Promise<void>;
  };
  keyboard: {
    press(key: string): Promise<void>;
  };
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  screenshot(options?: { type?: 'png' | 'jpeg' }): Promise<Buffer>;
  content(): Promise<string>;
  evaluate<R>(fn: () => R): Promise<R>;
  on(event: 'console', listener: (msg: { type(): string; text(): string }) => void): void;
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
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

export class PlaywrightBackend implements BrowserBackend {
  readonly name = 'playwright';
  private browser: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;
  private readonly consoleLogs: BrowserConsoleMessage[] = [];

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
      this.page = await context.newPage();
      this.page.on('console', (msg) => {
        this.consoleLogs.push({
          type: msg.type(),
          text: msg.text(),
        });
      });
      return this.page;
    } catch (err) {
      throw new Error(
        `Failed to launch Playwright browser: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
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

    const snapshotText = await page.evaluate<string>(() => {
      // Evaluated in browser context where document exists
      return (globalThis as unknown as { eval: (code: string) => string }).eval(snapshotScript);
    });

    return snapshotText;
  }

  async click(ref: string): Promise<void> {
    const page = await this.ensurePage();
    // Support ref as @id, [data-ref=...], #id, or selector
    const selector = ref.startsWith('@') ? `[data-ref="${ref.slice(1)}"], #${ref.slice(1)}` : ref;
    await page.locator(selector).click();
  }

  async type(ref: string, text: string): Promise<void> {
    const page = await this.ensurePage();
    const selector = ref.startsWith('@') ? `[data-ref="${ref.slice(1)}"], #${ref.slice(1)}` : ref;
    await page.locator(selector).fill(text);
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
      this.page = null;
    }
  }
}
