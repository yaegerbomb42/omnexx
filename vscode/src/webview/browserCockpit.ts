/**
 * The live browser cockpit in the chat webview: a tabs panel over the agent's viewport with the
 * screenshot, the console/network problems it found, and the latest visual comparison.
 *
 * The extension forwards frames and diagnostics as separate messages so a high-frequency stream
 * of screenshots never re-renders the console list, and vice versa.
 */
import { escapeHtml } from './render.js';

export interface BrowserFrameMsg {
  seq: number;
  mime: string;
  url: string;
  action: string;
  data: string;
}

export interface BrowserConsoleMsg {
  type: string;
  text: string;
  location?: string;
}

export interface BrowserRequestMsg {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  failure?: string;
}

export interface BrowserDiagnosticsMsg {
  seq: number;
  at: number;
  action: string;
  url: string;
  errors: number;
  warnings: number;
  failedRequests: number;
  console: BrowserConsoleMsg[];
  requests: BrowserRequestMsg[];
  summary: string;
}

export interface BrowserVisualMsg {
  seq: number;
  at: number;
  name: string;
  pass: boolean;
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  width: number;
  height: number;
  dimensionsMatch: boolean;
  baselineWidth: number;
  baselineHeight: number;
  currentWidth: number;
  currentHeight: number;
  meanDelta: number;
  baseline: string;
  current: string;
  diff?: string;
  mime?: string;
  data?: string;
}

type Tab = 'preview' | 'console' | 'network' | 'visual';

let lastFrame = 0;
let lastDiagnostics = 0;
let lastVisual = 0;
let currentTab: Tab = 'preview';
let currentDiagnostics: BrowserDiagnosticsMsg | undefined;
let currentVisual: BrowserVisualMsg | undefined;

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function selectTab(tab: Tab): void {
  currentTab = tab;
  for (const button of document.querySelectorAll<HTMLElement>('[data-btab]')) {
    const active = button.dataset.btab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-bpanel]')) {
    panel.hidden = panel.dataset.bpanel !== tab;
  }
}

function show(tab?: Tab): void {
  const section = el('browser');
  if (section) section.hidden = false;
  if (tab && tab !== currentTab) selectTab(tab);
}

function setBadge(id: string, text: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): void {
  const badge = el(id);
  if (!badge) return;
  badge.textContent = text;
  badge.className = `b-count${tone ? ` ${tone}` : ''}`;
  badge.hidden = !text;
}

export function drawFrame(f: BrowserFrameMsg): void {
  if (f.seq <= lastFrame) return;
  lastFrame = f.seq;
  show();
  const url = el('b-url');
  if (url) url.textContent = f.url || 'about:blank';
  const action = el('b-action');
  if (action) action.textContent = f.action;
  const status = el('b-status');
  if (status) status.textContent = `frame #${String(f.seq)}`;
  const img = el('b-img');
  if (img instanceof HTMLImageElement) img.src = `data:${f.mime};base64,${f.data}`;
  const dimmer = el('b-dimmer');
  if (dimmer) dimmer.hidden = true;
}

export function drawDiagnostics(d: BrowserDiagnosticsMsg): void {
  if (d.seq <= lastDiagnostics) return;
  lastDiagnostics = d.seq;
  currentDiagnostics = d;
  show();
  const url = el('b-url');
  if (url && d.url) url.textContent = d.url;

  setBadge('b-console-count', d.errors ? String(d.errors) : '', d.errors ? 'bad' : 'ok');
  setBadge(
    'b-network-count',
    d.failedRequests ? String(d.failedRequests) : '',
    d.failedRequests ? 'bad' : 'ok',
  );

  const consoleList = el('b-console');
  if (consoleList) {
    consoleList.innerHTML = d.console.length
      ? d.console
          .map(
            (m) =>
              `<li class="b-issue ${m.type === 'warning' ? 'warn' : 'bad'}"><span class="b-tag">${escapeHtml(m.type)}</span><code>${escapeHtml(m.text)}</code>${m.location ? `<span class="b-loc">${escapeHtml(m.location)}</span>` : ''}</li>`,
          )
          .join('')
      : '<li class="b-empty">No console errors or warnings.</li>';
  }
  const networkList = el('b-network');
  if (networkList) {
    networkList.innerHTML = d.requests.length
      ? d.requests
          .map((r) => {
            const status =
              r.status === undefined
                ? r.failure
                  ? `FAILED ${r.failure}`
                  : 'FAILED'
                : String(r.status);
            return `<li class="b-issue bad"><span class="b-tag">${escapeHtml(status)}</span><span class="b-method">${escapeHtml(r.method)}</span><code>${escapeHtml(r.url)}</code>${r.resourceType ? `<span class="b-loc">${escapeHtml(r.resourceType)}</span>` : ''}</li>`;
          })
          .join('')
      : '<li class="b-empty">No failed requests.</li>';
  }

  const status = el('b-status');
  if (status) {
    status.textContent = d.errors || d.failedRequests ? d.summary : `frame #${String(lastFrame)}`;
  }
}

export function drawVisual(v: BrowserVisualMsg): void {
  if (v.seq <= lastVisual) return;
  lastVisual = v.seq;
  currentVisual = v;
  show();
  setBadge('b-visual-count', v.pass ? '✓' : '!', v.pass ? 'ok' : 'bad');

  const summary = el('b-visual-summary');
  if (summary) {
    const pct = `${(v.changedRatio * 100).toFixed(2)}%`;
    const size = v.dimensionsMatch
      ? `${String(v.width)}×${String(v.height)}`
      : `${String(v.baselineWidth)}×${String(v.baselineHeight)} → ${String(v.currentWidth)}×${String(v.currentHeight)}`;
    summary.innerHTML = `<div class="b-visual-verdict ${v.pass ? 'ok' : 'bad'}">${v.pass ? '✓ match' : '✗ changed'} · ${escapeHtml(v.name)}</div><div class="b-visual-facts"><span>${escapeHtml(pct)} pixels changed</span><span>${escapeHtml(size)}</span><span>mean Δ ${(v.meanDelta * 100).toFixed(2)}%</span></div><div class="b-visual-files"><code>${escapeHtml(v.baseline)}</code></div>`;
  }
  const img = el('b-visual-img');
  if (img instanceof HTMLImageElement && v.data) {
    img.src = `data:${v.mime ?? 'image/png'};base64,${v.data}`;
    img.hidden = false;
  }
}

export function resetCockpit(): void {
  lastFrame = 0;
  lastDiagnostics = 0;
  lastVisual = 0;
  currentDiagnostics = undefined;
  currentVisual = undefined;
  const section = el('browser');
  if (section) section.hidden = true;
  selectTab('preview');
  setBadge('b-console-count', '');
  setBadge('b-network-count', '');
  setBadge('b-visual-count', '');
  const consoleList = el('b-console');
  if (consoleList) consoleList.innerHTML = '';
  const networkList = el('b-network');
  if (networkList) networkList.innerHTML = '';
  const visual = el('b-visual-summary');
  if (visual) visual.innerHTML = '';
  const visualImg = el('b-visual-img');
  if (visualImg instanceof HTMLImageElement) {
    visualImg.hidden = true;
    visualImg.removeAttribute('src');
  }
}

/** Wire tab clicks and the image's expand toggle. Safe to call once. */
export function wireCockpit(): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-btab]')) {
    button.addEventListener('click', () => {
      const tab = button.dataset.btab;
      if (tab === 'preview' || tab === 'console' || tab === 'network' || tab === 'visual')
        selectTab(tab);
    });
  }
  el('b-img')?.addEventListener('click', () => {
    el('browser')?.classList.toggle('big');
  });
}

/** Re-apply tab state after the section is shown again (kept for parity with older webviews). */
export function refreshCockpit(): void {
  selectTab(currentTab);
  if (currentDiagnostics) drawDiagnostics({ ...currentDiagnostics, seq: lastDiagnostics + 1 });
  if (currentVisual) drawVisual({ ...currentVisual, seq: lastVisual + 1 });
}
