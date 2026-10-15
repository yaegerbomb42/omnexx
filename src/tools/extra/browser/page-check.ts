import type { BrowserConsoleMessage, BrowserRequest } from './types.js';

/** What the in-page layout probe reports. */
export interface LayoutReport {
  title: string;
  viewport: { w: number; h: number };
  scrollWidth: number;
  /** Outermost elements sticking out past the right edge, as "selector (+Npx)". */
  overflow: string[];
  /** Pairs of visible content elements drawn on top of each other. */
  overlaps: string[];
  /** Images that failed to load or have no size. */
  brokenImages: string[];
  /** Characters of visible text: 0 is a blank page. */
  textChars: number;
}

export interface PageCheckInput {
  url: string;
  screenshot: string;
  console: BrowserConsoleMessage[];
  requests: BrowserRequest[];
  layout: LayoutReport | null;
}

/** Each list in the report keeps at most this many entries. */
export const MAX_FINDINGS = 5;
const MAX_LINE = 200;

/**
 * Runs in the page (via the backend's evaluate) and returns a LayoutReport. Fixed code from
 * omnexx, never model input, so it runs even when [browser] allow_eval is off.
 */
export const LAYOUT_PROBE = `(() => {
  const MAX = ${MAX_FINDINGS};
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    return cls.length ? s + '.' + cls.join('.') : s;
  };
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = Array.from(document.body ? document.body.querySelectorAll('*') : []);
  const overflowing = new Set(all.filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1
    && getComputedStyle(el).position !== 'fixed'));
  const overflow = Array.from(overflowing)
    .filter((el) => !overflowing.has(el.parentElement))
    .slice(0, MAX)
    .map((el) => name(el) + ' (+' + Math.round(el.getBoundingClientRect().right - vw) + 'px)');
  const content = all.filter((el) => /^(H[1-6]|P|LI|BUTTON|A|IMG|INPUT|LABEL|TEXTAREA|SELECT)$/.test(el.tagName) && visible(el)).slice(0, 300);
  const overlaps = [];
  for (let i = 0; i < content.length && overlaps.length < MAX; i++) {
    const a = content[i], ra = a.getBoundingClientRect();
    for (let j = i + 1; j < content.length && overlaps.length < MAX; j++) {
      const b = content[j];
      if (a.contains(b) || b.contains(a)) continue;
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 4 && h > 4) overlaps.push(name(a) + ' overlaps ' + name(b));
    }
  }
  const brokenImages = Array.from(document.images)
    .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src))
    .slice(0, MAX)
    .map((img) => img.getAttribute('src') || img.currentSrc);
  return {
    title: document.title,
    viewport: { w: vw, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    overflow, overlaps, brokenImages,
    textChars: (document.body ? document.body.innerText : '').trim().length,
  };
})()`;

/** A LayoutReport from an evaluate() result, or null when it isn't one. */
export function asLayoutReport(v: unknown): LayoutReport | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<LayoutReport>;
  if (!Array.isArray(r.overflow) || !Array.isArray(r.overlaps) || !r.viewport) return null;
  return {
    title: r.title ?? '',
    viewport: r.viewport,
    scrollWidth: r.scrollWidth ?? 0,
    overflow: r.overflow.map(String),
    overlaps: r.overlaps.map(String),
    brokenImages: (r.brokenImages ?? []).map(String),
    textChars: r.textChars ?? 0,
  };
}

const clip = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s);

function section(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_FINDINGS).map((i) => `  - ${clip(i)}`);
  const more = items.length > MAX_FINDINGS ? [`  - … ${items.length - MAX_FINDINGS} more`] : [];
  return [`${title} (${items.length}):`, ...shown, ...more];
}

function layoutFindings(l: LayoutReport): string[] {
  const out: string[] = [];
  if (l.scrollWidth > l.viewport.w)
    out.push(
      `Horizontal overflow: page is ${l.scrollWidth}px wide in a ${l.viewport.w}px viewport.`,
      ...section('Sticking out', l.overflow),
    );
  if (l.textChars === 0) out.push('The page shows no text (blank render?).');
  out.push(...section('Overlapping elements', l.overlaps));
  out.push(...section('Broken images', l.brokenImages));
  return out;
}

/**
 * The compact "check my frontend" report: one status line, then only the problems found.
 * Network failures and console errors come from the page load the check made.
 */
export function formatPageCheck(c: PageCheckInput): string {
  const errors = c.console.filter((m) => /error|assert/i.test(m.type)).map((m) => m.text);
  const warnings = c.console.filter((m) => /warn/i.test(m.type)).length;
  const failed = c.requests
    .filter((r) => r.status === undefined || r.status >= 400)
    .map((r) => `${r.status ?? 'FAILED'} ${r.method} ${r.url}`);
  const layout = c.layout
    ? layoutFindings(c.layout)
    : ['Layout checks unavailable on this backend.'];
  const problems = [
    ...section('Console errors', errors),
    ...section('Failed requests', failed),
    ...(c.layout ? layout : []),
  ];
  const size = c.layout ? `, viewport ${c.layout.viewport.w}x${c.layout.viewport.h}` : '';
  const title = c.layout?.title ? ` "${clip(c.layout.title)}"` : '';
  const head = `Checked ${c.url}${title}${size}. Screenshot: ${c.screenshot}`;
  const verdict =
    problems.length === 0
      ? `No problems found${warnings ? ` (${warnings} console warnings)` : ''}.`
      : `Problems:\n${problems.join('\n')}`;
  return [head, verdict, ...(c.layout ? [] : layout)].join('\n');
}
