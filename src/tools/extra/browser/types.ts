export interface BrowserConsoleMessage {
  type: string;
  text: string;
  /** `url:line:column` when the backend reports one. */
  location?: string;
}

export interface ScreenshotResult {
  /** Base64-encoded image data */
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
}

export interface BrowserTab {
  /** Backend tab id ("t1" for agent-browser, "1" for playwright); pass it to switchTab/closeTab. */
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserRequest {
  method: string;
  url: string;
  /** Absent when the request has no response yet or failed at the network level. */
  status?: number;
  resourceType?: string;
  /** Why no response arrived (DNS, refused, aborted); set for network-level failures. */
  failure?: string;
}

/** What `waitFor` waits for: an element (ref or CSS selector) or text anywhere on the page. */
export type WaitTarget = { selector: string } | { text: string };

/**
 * The core actions every backend has; the rest are optional so a backend that can't do one
 * leaves it out and the tool tells the model so instead of failing obscurely.
 */
export interface BrowserBackend {
  readonly name: string;
  open(url: string): Promise<void>;
  snapshot(): Promise<string>;
  click(ref: string): Promise<void>;
  /** Types after any existing value. */
  type(ref: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction?: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
  screenshot(): Promise<ScreenshotResult>;
  /** Screenshot of one element (its bounding box), for before/after UI comparison. */
  screenshotElement?(ref: string): Promise<ScreenshotResult>;
  console(): Promise<BrowserConsoleMessage[]>;
  /** Drop buffered console messages so the next diagnostics only report what follows. */
  clearConsole?(): Promise<void>;
  reload?(): Promise<void>;
  goBack?(): Promise<void>;
  goForward?(): Promise<void>;
  close(): Promise<void>;

  /** Resolves when the target appears; rejects after `timeoutMs`. */
  waitFor?(target: WaitTarget, timeoutMs: number): Promise<void>;
  /** Best-effort settle after navigation: the document finished loading. */
  waitForLoad?(timeoutMs: number): Promise<void>;
  /** Clears the field, then types. */
  fill?(ref: string, text: string): Promise<void>;
  /** Chooses a dropdown option by value or visible label. */
  select?(ref: string, value: string): Promise<void>;
  setChecked?(ref: string, checked: boolean): Promise<void>;
  /** `file` is an absolute path already checked against the repo jail. */
  upload?(ref: string, file: string): Promise<void>;
  hover?(ref: string): Promise<void>;
  getText?(ref: string): Promise<string>;
  getUrl?(): Promise<string>;
  /** Resizes the viewport, e.g. to check a page at phone width. */
  setViewport?(width: number, height: number): Promise<void>;
  /** Evaluates a JS expression in the page and returns its JSON-serializable result. */
  evaluate?(expression: string): Promise<unknown>;
  network?(): Promise<BrowserRequest[]>;
  /** Drop the request log so a later `network` call only shows what follows. */
  clearNetwork?(): Promise<void>;
  tabs?(): Promise<BrowserTab[]>;
  switchTab?(id: string): Promise<void>;
  /** Opens `url` in a new tab and makes it active. */
  newTab?(url: string): Promise<void>;
  /** Closes the given tab, or the active one. */
  closeTab?(id?: string): Promise<void>;
}

export interface BackendDetectResult {
  backend: 'agent-browser' | 'playwright' | null;
  detail: string;
}

/** How the browser starts: window, engine, and what state it carries between runs. */
export interface BrowserLaunch {
  headless: boolean;
  engine: 'chromium' | 'camoufox';
  /** A profile to reuse (logins, cookies); see browser.profile. */
  profile?: string | undefined;
  /** agent-browser: save and restore cookies and storage under this name. */
  sessionName?: string | undefined;
}
