export interface BrowserOpenEvent {
  url: string;
  backend: string;
}

export interface BrowserActionEvent {
  action: 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'screenshot' | 'console' | 'close';
  ref?: string;
  text?: string;
  key?: string;
  direction?: string;
  count?: number;
}

export interface BrowserCloseEvent {
  runId: string;
}

export interface BrowserDeniedEvent {
  url: string;
  allow: readonly string[];
  reason: string;
}
