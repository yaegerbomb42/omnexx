import type {
  BrowserBackend,
  BrowserConsoleMessage,
  BrowserRequest,
  BrowserTab,
  ScreenshotResult,
  WaitTarget,
  BrowserLaunch,
} from './types.js';
import { parseSemantic } from './selector.js';

/**
 * Optional peer deps are imported via a non-literal specifier so TypeScript and
 * bundlers (tsup/vite) never try to resolve them at build time; whether they
 * happen to be installed somewhere on the machine must not change the build.
 */
/** How long a click waits for a tab it may have opened. */
const POPUP_GRACE_MS = 500;

function optionalModule(name: string): string {
  return name;
}

interface Timeout {
  timeout: number;
}

interface PlaywrightLocator {
  click(o: Timeout): Promise<void>;
  fill(text: string, o: Timeout): Promise<void>;
  pressSequentially(text: string, o: Timeout): Promise<void>;
  selectOption(value: string | { label: string }, o: Timeout): Promise<string[]>;
  setChecked(checked: boolean, o: Timeout): Promise<void>;
  setInputFiles(file: string, o: Timeout): Promise<void>;
  hover(o: Timeout): Promise<void>;
  innerText(o: Timeout): Promise<string>;
  screenshot(options?: { type?: 'png' | 'jpeg' }): Promise<Buffer>;
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
  goBack(options?: { timeout?: number }): Promise<unknown>;
  goForward(options?: { timeout?: number }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): PlaywrightLocator;
  getByText(text: string): PlaywrightLocator;
  getByLabel(text: string): PlaywrightLocator;
  getByPlaceholder(text: string): PlaywrightLocator;
  getByRole(role: string, options?: { name: string }): PlaywrightLocator;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
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
  waitForLoadState(
    state: 'networkidle' | 'domcontentloaded',
    options: { timeout: number },
  ): Promise<void>;
  waitForEvent?(event: 'popup', options: { timeout: number }): Promise<PlaywrightPage>;
  evaluate<R>(fn: (() => R) | string): Promise<R>;
  on(
    event: 'console',
    listener: (msg: {
      type(): string;
      text(): string;
      location?(): { url: string; lineNumber: number; columnNumber: number };
    }) => void,
  ): void;
  on(event: 'pageerror', listener: (err: Error) => void): void;
  on(event: 'response', listener: (res: PlaywrightResponse) => void): void;
  on(
    event: 'requestfailed',
    listener: (req: {
      method(): string;
      url(): string;
      resourceType(): string;
      failure?(): { errorText: string } | null;
    }) => void,
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

interface BrowserType {
  launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
  /** A browser whose state (logins, cookies) lives in `userDataDir` across runs. */
  launchPersistentContext(
    userDataDir: string,
    options?: Record<string, unknown>,
  ): Promise<PlaywrightBrowserContext & { close(): Promise<void> }>;
}

interface PlaywrightCoreModule {
  chromium: BrowserType;
  firefox: BrowserType;
}

/** camoufox-js: launch options for its patched, anti-detection Firefox. Optional. */
interface CamoufoxModule {
  launchOptions(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const CAMOUFOX_HELP =
  'Camoufox needs playwright-core, camoufox-js and its browser: `npm i -g playwright-core camoufox-js && npx camoufox-js fetch` (or set browser.engine = "chromium").';

/** Every element action fails after this instead of Playwright's 30 s default. */
const ACTION_TIMEOUT_MS = 10_000;
const T: Timeout = { timeout: ACTION_TIMEOUT_MS };
const NAV_TIMEOUT_MS = 30_000;

/** Recent requests kept for `network`; older ones are dropped. */
const MAX_REQUESTS = 200;

export class PlaywrightBackend implements BrowserBackend {
  readonly name = 'playwright';
  private browser: PlaywrightBrowser | null = null;
  /** Set instead of `browser` when a profile folder is used. */
  private persistent: { close(): Promise<void> } | null = null;
  private context: PlaywrightBrowserContext | null = null;
  private page: PlaywrightPage | null = null;
  /** Open pages in opening order; index + 1 is the tab id. */
  private readonly pages: PlaywrightPage[] = [];
  private readonly consoleLogs: BrowserConsoleMessage[] = [];
  private readonly requests: BrowserRequest[] = [];

  private readonly launch: BrowserLaunch;

  constructor(launch: boolean | Partial<BrowserLaunch> = true) {
    const opts = typeof launch === 'boolean' ? { headless: launch } : launch;
    this.launch = {
      headless: opts.headless ?? true,
      engine: opts.engine ?? 'chromium',
      profile: opts.profile,
    };
  }

  /** The browser type and options for the configured engine. */
  private async engine(pw: PlaywrightCoreModule): Promise<{
    type: BrowserType;
    options: Record<string, unknown>;
  }> {
    const { headless } = this.launch;
    if (this.launch.engine !== 'camoufox') return { type: pw.chromium, options: { headless } };
    let cf: CamoufoxModule;
    try {
      cf = (await import(/* @vite-ignore */ optionalModule('camoufox-js'))) as CamoufoxModule;
    } catch (err) {
      throw new Error(CAMOUFOX_HELP, { cause: err });
    }
    return { type: pw.firefox, options: await cf.launchOptions({ headless }) };
  }

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page;

    let pw: PlaywrightCoreModule;
    try {
      // Dynamic import of playwright-core as optional peer dependency
      pw = (await import(
        /* @vite-ignore */ optionalModule('playwright-core')
      )) as PlaywrightCoreModule;
    } catch (importErr) {
      throw new Error(
        this.launch.engine === 'camoufox'
          ? CAMOUFOX_HELP
          : 'playwright-core is not installed. Run `npm install -D playwright-core` or install agent-browser to enable the browser tool.',
        { cause: importErr },
      );
    }

    try {
      const { type, options } = await this.engine(pw);
      let context: PlaywrightBrowserContext;
      if (this.launch.profile) {
        // The profile folder keeps logins and cookies between runs; closing the context closes it.
        const persistent = await type.launchPersistentContext(this.launch.profile, options);
        this.persistent = persistent;
        context = persistent;
      } else {
        this.browser = await type.launch(options);
        context = await this.browser.newContext();
      }
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
      const location = msg.location?.();
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        ...(location?.url
          ? {
              location: `${location.url}:${String(location.lineNumber)}:${String(location.columnNumber)}`,
            }
          : {}),
      });
    });
    // Uncaught exceptions never reach the console listener; report them as errors too.
    page.on('pageerror', (err) => {
      this.consoleLogs.push({ type: 'pageerror', text: err.message });
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
      const failure = req.failure?.()?.errorText;
      this.record({
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        ...(failure ? { failure } : {}),
      });
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

  private locate(page: PlaywrightPage, ref: string): PlaywrightLocator {
    const sem = parseSemantic(ref);
    if (!sem) return page.locator(this.toSelector(ref)).first();
    switch (sem.by) {
      case 'text':
        return page.getByText(sem.value).first();
      case 'label':
        return page.getByLabel(sem.value).first();
      case 'placeholder':
        return page.getByPlaceholder(sem.value).first();
      case 'role':
        return page.getByRole(sem.role, sem.name ? { name: sem.name } : undefined).first();
    }
  }

  private async loc(ref: string): Promise<PlaywrightLocator> {
    return this.locate(await this.ensurePage(), ref);
  }

  async open(url: string): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(url, { timeout: NAV_TIMEOUT_MS });
  }

  async reload(): Promise<void> {
    await (await this.ensurePage()).reload({ timeout: NAV_TIMEOUT_MS });
  }

  async goBack(): Promise<void> {
    await (await this.ensurePage()).goBack({ timeout: NAV_TIMEOUT_MS });
  }

  async goForward(): Promise<void> {
    await (await this.ensurePage()).goForward({ timeout: NAV_TIMEOUT_MS });
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
    const page = await this.ensurePage();
    // A click can open a tab (target=_blank, window.open). Playwright reports it a moment after
    // click() resolves, so wait briefly for it: a following `tabs` call must already list it.
    const popup = page.waitForEvent
      ? page.waitForEvent('popup', { timeout: POPUP_GRACE_MS }).catch(() => null)
      : Promise.resolve(null);
    await (await this.loc(ref)).click(T);
    const opened = await popup;
    if (opened) {
      this.track(opened);
      this.page = opened;
      await opened.waitForLoadState('domcontentloaded', T).catch(() => undefined);
    }
  }

  async type(ref: string, text: string): Promise<void> {
    await (await this.loc(ref)).pressSequentially(text, T);
  }

  async fill(ref: string, text: string): Promise<void> {
    await (await this.loc(ref)).fill(text, T);
  }

  async select(ref: string, value: string): Promise<void> {
    const l = await this.loc(ref);
    // A value that matches no option is treated as the option's visible label.
    try {
      await l.selectOption(value, T);
    } catch {
      await l.selectOption({ label: value }, T);
    }
  }

  async setChecked(ref: string, checked: boolean): Promise<void> {
    await (await this.loc(ref)).setChecked(checked, T);
  }

  async upload(ref: string, file: string): Promise<void> {
    await (await this.loc(ref)).setInputFiles(file, T);
  }

  async hover(ref: string): Promise<void> {
    await (await this.loc(ref)).hover(T);
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
      'text' in target ? page.getByText(target.text).first() : this.locate(page, target.selector);
    await l.waitFor({ state: 'visible', timeout: timeoutMs });
  }

  async waitForLoad(timeoutMs: number): Promise<void> {
    const page = await this.ensurePage();
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  }

  async getText(ref: string): Promise<string> {
    return (await this.loc(ref)).innerText(T);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await (await this.ensurePage()).setViewportSize({ width, height });
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
    await p.goto(url, { timeout: NAV_TIMEOUT_MS });
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

  async screenshotElement(ref: string): Promise<ScreenshotResult> {
    const buffer = await (await this.loc(ref)).screenshot({ type: 'png' });
    return { base64: buffer.toString('base64'), mimeType: 'image/png' };
  }

  async console(): Promise<BrowserConsoleMessage[]> {
    await this.ensurePage();
    return [...this.consoleLogs];
  }

  clearConsole(): Promise<void> {
    this.consoleLogs.length = 0;
    return Promise.resolve();
  }

  clearNetwork(): Promise<void> {
    this.requests.length = 0;
    return Promise.resolve();
  }

  async close(): Promise<void> {
    const owner = this.browser ?? this.persistent;
    if (!owner) return;
    await owner.close().catch(() => undefined);
    this.browser = null;
    this.persistent = null;
    this.context = null;
    this.page = null;
    this.pages.length = 0;
  }
}
