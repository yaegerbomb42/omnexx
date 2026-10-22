import type { BrowserDiagnostics } from '../../browser/diagnostics.js';
import type { VisualDiffSummary } from '../../browser/visual-diff.js';

export interface BrowserOpenEvent {
  url: string;
  backend: string;
}

export interface BrowserActionEvent {
  action:
    | 'open'
    | 'snapshot'
    | 'click'
    | 'type'
    | 'fill'
    | 'press'
    | 'scroll'
    | 'screenshot'
    | 'console'
    | 'network'
    | 'diagnostics'
    | 'back'
    | 'forward'
    | 'reload'
    | 'start_server'
    | 'stop_server'
    | 'visual_check'
    | 'close';
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

/** New frontend problems, emitted after the action that caused them or by `diagnostics`. */
export interface BrowserDiagnosticsEvent extends BrowserDiagnostics {
  action: string;
  url: string;
}

/** A completed visual comparison (or a new baseline), for the editor cockpit. */
export interface BrowserVisualEvent extends VisualDiffSummary {
  action?: 'baseline' | 'compare';
  name: string;
  baseline: string;
  current: string;
  diff?: string;
}
