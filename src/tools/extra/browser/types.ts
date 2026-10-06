export interface BrowserConsoleMessage {
  type: string;
  text: string;
}

export interface ScreenshotResult {
  /** Base64-encoded image data */
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
}

export interface BrowserBackend {
  readonly name: string;
  open(url: string): Promise<void>;
  snapshot(): Promise<string>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction?: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
  screenshot(): Promise<ScreenshotResult>;
  console(): Promise<BrowserConsoleMessage[]>;
  close(): Promise<void>;
}

export interface BackendDetectResult {
  backend: 'agent-browser' | 'playwright' | null;
  detail: string;
}
