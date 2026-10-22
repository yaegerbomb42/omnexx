/**
 * The chat panel's script (runs inside the webview). It draws what the extension forwards from
 * `omnexx chat-server` and posts the person's actions back; it never talks to omnexx itself.
 *
 * Architectural highlights:
 * - Frame-coalesced rendering (`requestAnimationFrame`) to eliminate high-frequency IPC jank.
 * - Keyed block reconciliation so historical messages and open `<details>` accordions never reset.
 * - Dedicated live streaming region for real-time `<think>` reasoning and active tool telemetry.
 */
import {
  addEntries,
  blockSignature,
  cacheHitPercent,
  cleanQuestion,
  contextPercent,
  escapeHtml,
  estimateHtml,
  etaText,
  formatClock,
  formatTokens,
  formatUsd,
  logRole,
  mountedRange,
  renderMarkdown,
  splitThinkContent,
  stepLabel,
  stepsPercent,
  stepStates,
  type Block,
  type Entry,
  type TodoItem,
  toolBadgeLabel,
  toolKind,
  type ToolKind,
  toolLineHtml,
  type Usage,
} from './render.js';
import { attachSuggest } from './suggestBox.js';
import * as agentCard from './agentCard.js';
import * as browserCockpit from './browserCockpit.js';
import * as contextPage from './contextPage.js';
import * as crew from './crew.js';
import * as domain from './domain.js';
import * as inspector from './inspector.js';
import * as modelPicker from './modelPicker.js';
import * as posture from './posture.js';
import * as settings from './settings.js';
import * as stats from './stats.js';

interface State {
  entries: Entry[];
  live: string;
  todos: TodoItem[];
  pending: string | null;
  /** Set for offers such as pulling an Ollama model: the button names. */
  pendingLabels?: { yes: string; no: string } | null;
  mode: 'chat' | 'plan' | 'run';
  busy: boolean;
  paused: boolean;
  autoApprove: boolean;
  /** Per-turn trace lines. Absent on an older omnexx: treated as off. */
  trace?: boolean;
  model: string | null;
  /** How the chat's ranked models are used, when it has several ("Fallback on quota"). */
  routing?: string | null;
  context: {
    used: number;
    limit: number;
    parts?: { system: number; tools: number; conversation: number };
  } | null;
  usage: (Usage & { startedAt: number | null }) | null;
  helpers?: crew.Helper[];
  waiting?: { startedAt: number; estimateMs: number | null } | null;
  estimate?: string | null;
  browserDiagnostics?: {
    seq: number;
    at: number;
    summary: string;
    errors: number;
    warnings: number;
    failedRequests: number;
  } | null;
  browserVisual?: {
    seq: number;
    at: number;
    name: string;
    pass: boolean;
    changedRatio: number;
    dimensionsMatch: boolean;
  } | null;
}

type Incoming =
  | ({ type: 'state' } & State)
  | ({
      type:
        | 'settings'
        | 'models'
        | 'prefs'
        | 'providerTest'
        | 'roles'
        | 'contextFiles'
        | 'engine'
        | 'browser'
        | 'agentSettings'
        | 'executionMode'
        | 'workDomain';
    } & Record<string, unknown>)
  | ({ type: 'browserFrame' } & browserCockpit.BrowserFrameMsg)
  | ({ type: 'browserDiagnostics' } & browserCockpit.BrowserDiagnosticsMsg)
  | ({ type: 'browserVisual' } & browserCockpit.BrowserVisualMsg)
  | { type: 'ui'; action: string }
  | { type: 'files'; items: string[] }
  | { type: 'insert'; text: string }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }
  | { type: 'down'; message: string };

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface LogLine {
  at: number;
  role: NonNullable<ReturnType<typeof logRole>>;
  text: string;
}

const MAX_LOG_LINES = 400;
const ACTIVE_STEP_ACTIONS = 4;
const CLOCK_TICK_MS = 1_000;
const THINK_PREVIEW_LINES = 2;
const TOOL_CLUSTER_COLLAPSE_THRESHOLD = 6;

const vscode = acquireVsCodeApi();
const post = (msg: Record<string, unknown>): void => {
  vscode.postMessage(msg);
};

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`missing #${id}`);
  return found;
}

const conversation = el('log', HTMLElement);
const input = el('input', HTMLTextAreaElement);
const send = el('send', HTMLButtonElement);
const pauseBtn = el('pause', HTMLButtonElement);
const ask = el('ask', HTMLElement);
const steps = el('steps', HTMLElement);
const stepsBody = el('steps-body', HTMLElement);
const banner = el('banner', HTMLElement);
const welcome = el('welcome', HTMLElement);
/** The head agent's avatar in the crew view: the extension logo. */
const logoSrc = document.body.dataset.logo ?? '';

/**
 * Partition `#log` into two persistent sub-containers:
 * 1. `blocksRoot`: keyed historical blocks reconciled incrementally.
 * 2. `liveRoot`: high-frequency streaming thoughts, markdown tokens, and active tool cockpit.
 */
const blocksRoot = document.createElement('div');
blocksRoot.className = 'blocks-root';
const liveRoot = document.createElement('div');
liveRoot.className = 'live-root';
conversation.append(blocksRoot, liveRoot);

let blocks: Block[] = [];
let logLines: LogLine[] = [];
let state: State | undefined;
let lastStepsSignature = '';
let rafPending = false;
let pendingState: State | null = null;
let lastLiveHtml = '';
let needsRedrawAfterSelect = false;

/** Tracks user-toggled `<details>` accordions by stable key so re-renders never collapse them. */
const openDisclosures = new Set<string>();

/** Keep a scroller pinned to the bottom unless the person scrolled up to read. */
const stick = { conversation: true };
const jumpBtn = el('jump', HTMLButtonElement);
/** Messages sent this session, newest last, for ↑/↓ recall in an empty composer. */
const sent: string[] = [];
let recall = -1;

const ICON = {
  check:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spinner: '<span class="spinner" aria-hidden="true"></span>',
  wait: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  dot: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  brain:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3a2.5 2.5 0 0 0-2.4 3.2A2.5 2.5 0 0 0 4 11a2.5 2.5 0 0 0 2 2.4V3zm4 0a2.5 2.5 0 0 1 2.4 3.2A2.5 2.5 0 0 1 12 11a2.5 2.5 0 0 1-2 2.4V3z"/></svg>',
  terminal:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5l3 3-3 3m5 0h5"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>',
  edit: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z"/></svg>',
  diff: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v6M5 6h6M5 12h6"/></svg>',
  test: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h4m-3 0v4L3.5 12.5a1 1 0 0 0 .8 1.5h7.4a1 1 0 0 0 .8-1.5L9 6V2"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></svg>',
  mcp: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 7l4-2M6 9l4 2"/></svg>',
  tool: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2.5a2.12 2.12 0 0 0-3 0L3.5 9 2 13.5 6.5 12l6.5-6.5a2.12 2.12 0 0 0 0-3z"/></svg>',
};

const ICON_COPY =
  '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const ICON_EDIT =
  '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

function iconForToolKind(kind: ToolKind): string {
  switch (kind) {
    case 'run':
      return ICON.terminal;
    case 'read':
      return ICON.file;
    case 'edit':
      return ICON.edit;
    case 'diff':
      return ICON.diff;
    case 'test':
      return ICON.test;
    case 'search':
      return ICON.search;
    case 'mcp':
      return ICON.mcp;
    default:
      return ICON.tool;
  }
}

/** Everything shows in the conversation: actions and thinking as compact lines between messages. */
function ingest(entries: readonly Entry[]): void {
  if (!entries.length) return;
  const now = Date.now();
  const forLog: LogLine[] = [];
  for (const e of entries) {
    const role = logRole(e.kind);
    if (role) forLog.push({ at: now, role, text: e.text.trim() });
  }
  blocks = addEntries(
    blocks,
    entries.filter((e) => e.text.trim()),
  );
  logLines = [...logLines, ...forLog.filter((l) => l.text)].slice(-MAX_LOG_LINES);
}

/** Gives each fenced code block a language label, streaming badge (if active), and copy button. */
function withCopy(html: string): string {
  return html.replace(
    /<pre( data-lang="([^"]*)")?( data-streaming="true")?>/g,
    (_m, attr: string | undefined, lang: string | undefined, streaming: string | undefined) => {
      const streamBadge = streaming
        ? '<span class="code-stream-dot" title="Streaming code"></span>'
        : '';
      return `<pre${attr ?? ''}${streaming ?? ''}><span class="code-bar"><span class="code-lang">${streamBadge}${lang ?? ''}</span><button class="icon small" data-copy-code title="Copy code" aria-label="Copy code">${ICON_COPY}</button></span>`;
    },
  );
}

/** Renders a glassmorphic `<think>` accordion with live tail preview and persistent open state. */
function renderThinkAccordion(body: string, disclosureId: string, isStreaming: boolean): string {
  const clean = body.trim();
  const lines = clean.split('\n').filter((l) => l.trim());
  const wordCount = clean ? clean.split(/\s+/).length : 0;
  const estTokens = Math.max(1, Math.round(wordCount * 1.3));
  const streamClass = isStreaming ? ' is-streaming' : '';
  const statusLabel = isStreaming ? 'Reasoning…' : 'Thought Process';
  const countBadge = `<span class="think-badge">${String(wordCount)}w · ~${formatTokens(estTokens)} tok</span>`;
  const isOpen = openDisclosures.has(disclosureId);

  // Show the latest 2 lines during streaming so the user sees live progress while collapsed
  const previewSlice = isStreaming
    ? lines.slice(-THINK_PREVIEW_LINES)
    : lines.slice(0, THINK_PREVIEW_LINES);
  const previewText = previewSlice.join(' · ');

  if (lines.length <= 1 && !isStreaming) {
    return `<div class="msg think compact${streamClass}"><span class="think-header">${ICON.brain} <span>${statusLabel}</span> ${countBadge}</span><div class="think-body">${escapeHtml(clean)}</div></div>`;
  }

  return `<details class="msg think${streamClass}" data-disclosure-id="${disclosureId}"${isOpen ? ' open' : ''}><summary><span class="think-header">${ICON.brain} <span>${statusLabel}</span> ${countBadge}</span><span class="think-summary-text">${escapeHtml(previewText)}</span></summary><div class="think-body">${escapeHtml(clean)}</div></details>`;
}

/** Renders a grouped tool execution cluster with semantic pills and collapsible overflow. */
function renderToolCluster(b: Block, isActiveTail: boolean): string {
  const validLines = b.lines.filter((l) => l.trim());
  if (!validLines.length) return '';

  const renderItem = (line: string, idx: number): string => {
    const kind = toolKind(line);
    const isLiveItem = isActiveTail && idx === validLines.length - 1;
    const liveClass = isLiveItem ? ' is-live' : '';
    return `<li class="tool k-${kind}${liveClass}"><span class="tool-ico">${iconForToolKind(kind)}</span><span class="tool-badge k-${kind}">${toolBadgeLabel(kind)}</span><span class="tool-text">${toolLineHtml(line)}</span>${isLiveItem ? '<span class="tool-pulse" aria-hidden="true"></span>' : ''}</li>`;
  };

  if (validLines.length <= TOOL_CLUSTER_COLLAPSE_THRESHOLD) {
    return `<ul class="msg tools">${validLines.map(renderItem).join('')}</ul>`;
  }

  const disclosureId = `tools-${String(b.id)}`;
  const isOpen = openDisclosures.has(disclosureId);
  const hiddenCount = validLines.length - 3;
  const tailItems = validLines
    .slice(-3)
    .map((l, i) => renderItem(l, validLines.length - 3 + i))
    .join('');

  return `<div class="msg tools-cluster"><details class="tools-fold" data-disclosure-id="${disclosureId}"${isOpen ? ' open' : ''}><summary class="tools-summary"><span class="tools-count-pill">${String(validLines.length)} tool actions</span><span class="tools-expand-hint">Show ${String(hiddenCount)} earlier</span></summary><ul class="msg tools">${validLines.slice(0, -3).map(renderItem).join('')}</ul></details><ul class="msg tools tools-tail">${tailItems}</ul></div>`;
}

function messageHtml(b: Block, isActiveTail: boolean): string {
  const body = b.lines.join('\n');
  const id = String(b.id);

  if (b.kind === 'out') {
    const split = splitThinkContent(body);
    const thinkPart = split.thoughts.length
      ? renderThinkAccordion(
          split.thoughts.join('\n\n'),
          `think-inline-${id}`,
          split.isThinkingOpen && isActiveTail,
        )
      : '';
    const replyPart = split.reply
      ? `<div class="msg reply">${withCopy(renderMarkdown(split.reply))}<div class="msg-actions"><button class="icon small" data-copy-block="${id}" title="Copy reply" aria-label="Copy reply">${ICON_COPY}</button></div></div>`
      : '';
    return `${thinkPart}${replyPart}`;
  }

  if (b.kind === 'user') {
    return `<div class="msg user"><div class="who">You<button class="icon small" data-reuse="${id}" title="Edit and resend" aria-label="Edit and resend">${ICON_EDIT}</button></div><div class="text">${escapeHtml(body)}</div></div>`;
  }

  if (b.kind === 'act') {
    return renderToolCluster(b, isActiveTail);
  }

  if (b.kind === 'think') {
    return renderThinkAccordion(body, `think-${id}`, isActiveTail);
  }

  if (b.kind === 'system' || b.kind === 'feed') {
    return `<div class="msg note">${escapeHtml(body)}</div>`;
  }

  const text = b.lines.map((l) => l.trimStart().replace(/^✗ ?/, '')).join('\n');
  return `<div class="msg error">${escapeHtml(text)}</div>`;
}

/** True if the user currently has a non-empty text selection inside `container`. */
function hasActiveSelectionIn(container: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
  return container.contains(sel.anchorNode);
}

/**
 * Reconciles historical `blocks` into `blocksRoot` with minimal DOM mutations,
 * and updates `liveRoot` for active token streaming and tool execution status.
 */
function drawConversation(): void {
  welcome.hidden = blocks.length > 0 || Boolean(state?.live) || Boolean(state?.busy);

  const { start, hidden } = mountedRange(blocks.length);
  const shown = blocks.slice(start);
  const existing = new Map<string, HTMLElement>();
  let overflow = blocksRoot.querySelector<HTMLElement>(':scope > .history-overflow');
  for (const node of Array.from(blocksRoot.children)) {
    if (!(node instanceof HTMLElement) || !node.classList.contains('block-slot')) continue;
    const id = node.dataset.blockId;
    if (id) existing.set(id, node);
  }
  const next: HTMLElement[] = [];
  if (hidden > 0) {
    overflow ??= document.createElement('div');
    overflow.className = 'history-overflow msg note';
    overflow.textContent = `${String(hidden)} earlier messages`;
    next.push(overflow);
  }

  for (let i = 0; i < shown.length; i++) {
    const b = shown[i];
    if (!b) continue;
    const absIndex = start + i;
    const isActiveTail = Boolean(state?.busy) && absIndex === blocks.length - 1 && !state?.live;
    const sig = blockSignature(b, isActiveTail);
    const id = String(b.id);
    let slot = existing.get(id);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'block-slot';
      slot.dataset.blockId = id;
    }
    if (slot.dataset.sig !== sig) {
      if (hasActiveSelectionIn(slot)) {
        needsRedrawAfterSelect = true;
      } else {
        slot.dataset.sig = sig;
        slot.innerHTML = messageHtml(b, isActiveTail);
      }
    }
    next.push(slot);
  }
  blocksRoot.replaceChildren(...next);

  // Render the high-frequency live streaming & active tool cockpit region
  const liveParts: string[] = [];
  if (state?.live) {
    const split = splitThinkContent(state.live);
    if (split.thoughts.length > 0 || split.isThinkingOpen) {
      liveParts.push(
        renderThinkAccordion(
          split.thoughts.join('\n\n'),
          'think-live-stream',
          split.isThinkingOpen,
        ),
      );
    }
    if (split.reply) {
      liveParts.push(
        `<div class="msg reply streaming">${withCopy(renderMarkdown(split.reply))}<span class="stream-cursor" aria-hidden="true"></span></div>`,
      );
    }
  }

  if (state?.busy && !state.live && !state.pending) {
    const lastAgentLog = logLines.findLast((l) => l.role === 'agent')?.text;
    const doing = lastAgentLog ?? 'Synthesizing next step…';
    const kind: ToolKind = lastAgentLog ? toolKind(lastAgentLog) : 'tool';
    const badge = lastAgentLog
      ? `<span class="active-tool-pill k-${kind}"><span class="pill-ico">${iconForToolKind(kind)}</span><span class="pill-tag">${toolBadgeLabel(kind)}</span><span class="pill-body">${toolLineHtml(lastAgentLog)}</span></span>`
      : `<span class="active-tool-pill k-think">${ICON.brain}<span class="pill-body">${escapeHtml(doing)}</span></span>`;
    liveParts.push(
      `<div class="working cockpit-hud">${ICON.spinner}${badge}<span id="eta" class="eta">${etaText(state.waiting, Date.now())}</span>${state.paused ? '<span class="tag">paused</span>' : ''}</div>`,
    );
  }

  liveParts.push(estimateHtml(state?.estimate));
  const nextLiveHtml = liveParts.join('');
  if (lastLiveHtml !== nextLiveHtml) {
    lastLiveHtml = nextLiveHtml;
    liveRoot.innerHTML = nextLiveHtml;
  }

  if (stick.conversation) {
    conversation.scrollTop = conversation.scrollHeight;
  } else {
    jumpBtn.hidden = false;
  }
}

function stepDetail(s: string, states: readonly string[], pct: number, recent: string): string {
  if (s === 'active') {
    const doing = recent ? `<ul class="doing">${recent}</ul>` : '';
    const bar = `<div class="track"><div class="fill" style="width:${String(pct)}%"></div></div>`;
    return `<div class="progress" role="progressbar" aria-valuenow="${String(pct)}" aria-valuemin="0" aria-valuemax="100">${bar}<span>${String(pct)}%</span></div>${doing}`;
  }
  if (s === 'waiting' && states.includes('active'))
    return `<div class="sub">Waiting for ${stepLabel(states.indexOf('active'))}</div>`;
  return '';
}

function drawSteps(items: readonly TodoItem[]): void {
  steps.hidden = items.length === 0;
  if (!items.length) {
    lastStepsSignature = '';
    return;
  }
  const states = stepStates(items);
  const pct = stepsPercent(items);
  const recentLogs = logLines.filter((l) => l.role === 'agent').slice(-ACTIVE_STEP_ACTIONS);
  const stepsSig = `${items.map((t) => `${t.status}:${t.text}`).join('|')}#${recentLogs.map((l) => l.text).join('|')}`;
  if (stepsSig === lastStepsSignature) return;
  lastStepsSignature = stepsSig;

  const done = items.filter((t) => t.status === 'done').length;
  el('steps-count', HTMLElement).textContent = `${String(done)}/${String(items.length)}`;
  const current = states.indexOf('active');
  const shown = current >= 0 ? current : Math.min(done, items.length - 1);
  el('steps-now', HTMLElement).textContent =
    done === items.length ? 'All steps done' : `${stepLabel(shown)}: ${items[shown]?.text ?? ''}`;
  el('steps-bar', HTMLElement).style.width = `${String(pct)}%`;
  // Show recent actions with the newest/most recent action at the bottom
  const recent = recentLogs.map((l) => `<li>${toolLineHtml(l.text)}</li>`).join('');
  const icons = { done: ICON.check, active: ICON.spinner, waiting: ICON.wait, queued: ICON.dot };
  stepsBody.innerHTML = items
    .map((t, i) => {
      const s = states[i] ?? 'queued';
      return `<li class="step ${s}"><span class="node" aria-hidden="true"></span><div class="card"><div class="title"><span class="icon">${icons[s]}</span><span class="label">${stepLabel(i)}:</span><span class="text">${escapeHtml(t.text)}</span></div>${stepDetail(s, states, pct, recent)}</div></li>`;
    })
    .join('');
}

function stat(id: string, value: string, title: string): void {
  const node = el(id, HTMLElement);
  if (node.textContent !== value) node.textContent = value;
  node.parentElement?.setAttribute('title', title);
}

function turnsTitle(u: Usage | null): string {
  const failed = u?.toolErrors ? `, ${String(u.toolErrors)} failed` : '';
  return `Model calls this session; ${String(u?.toolCalls ?? 0)} tool calls${failed}`;
}

function drawStats(s: State): void {
  const u = s.usage;
  const tokens = u ? u.tokens.input + u.tokens.output : 0;
  stat('stat-turns', String(u?.turns ?? 0), turnsTitle(u));
  stat(
    'stat-tokens',
    formatTokens(tokens),
    u
      ? `${formatTokens(u.tokens.input)} in (${String(cacheHitPercent(u))}% from cache), ${formatTokens(u.tokens.output)} out`
      : 'No tokens used yet',
  );
  stat('stat-cost', formatUsd(u?.usd ?? 0), 'Spend this session');
  const cachePill = document.getElementById('stat-cache-pill');
  if (cachePill) {
    const rate = u ? cacheHitPercent(u) : 0;
    cachePill.textContent = `⚡ ${String(rate)}% cache`;
    cachePill.title = u
      ? `Prompt cache hit rate: ${String(rate)}% (${formatTokens(u.tokens.cacheRead)} cached tokens)`
      : 'Prompt cache hit rate';
  }
  drawUptime();
  const pct = contextPercent(s.context);
  const fill = el('ctx-fill', HTMLElement);
  fill.style.width = `${String(pct)}%`;
  fill.classList.toggle('hot', pct > 85);
  const ctxText = el('ctx-text', HTMLElement);
  ctxText.textContent = s.context ? `${String(pct)}%` : '—';
  ctxText.title = s.context
    ? `${formatTokens(s.context.used)} / ${formatTokens(s.context.limit)} tokens of context`
    : '';
  const parts = s.context?.parts;
  const why = el('ctx-parts', HTMLElement);
  why.textContent = parts
    ? `prompt ${formatTokens(parts.system)} · tools ${formatTokens(parts.tools)} · chat ${formatTokens(parts.conversation)}`
    : '';
  why.title = parts
    ? 'Sent with every request, even an empty chat: the system prompt (instructions and project notes) and the definitions of every tool the agent can use. The chat part grows as you talk and is trimmed or summarized as it fills.'
    : '';
}

function drawUptime(): void {
  const started = state?.usage?.startedAt;
  stat(
    'stat-uptime',
    started ? formatClock(Date.now() - started) : '00:00:00',
    'Time since this chat started',
  );
}

function placeholderFor(s: State): string {
  if (s.mode === 'run') return 'Describe a goal; omnexx works on it in the background…';
  if (s.mode === 'plan') return 'Describe the change; omnexx plans it without editing…';
  return s.busy
    ? 'Steer the agent (e.g. "use the existing helper")…'
    : 'Message omnexx  (@ files · / commands · ↑ history)';
}

function drawControls(s: State): void {
  const modelBtn = el('model', HTMLButtonElement);
  modelBtn.textContent = s.model
    ? `${s.model}${s.routing ? ` · ${s.routing}` : ''}`
    : 'Pick a model';
  modelBtn.title = s.routing
    ? `Serving now: ${s.model ?? '?'}. Your ranked list is used as: ${s.routing}`
    : 'Pick a model';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))
    b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode));
  const approval = el('approval', HTMLButtonElement);
  approval.hidden = !s.autoApprove;
  approval.classList.toggle('danger', s.autoApprove);
  approval.title = s.autoApprove
    ? 'omnexx goes ahead without asking (hard-blocked commands stay blocked). Click to ask first.'
    : 'omnexx asks before going outside the repo or running guarded commands. Click to auto-approve.';
  pauseBtn.disabled = !s.busy;
  pauseBtn.hidden = !s.busy;
  pauseBtn.dataset.action = s.paused ? 'resume' : 'pause';
  pauseBtn.title = s.paused ? 'Resume' : 'Pause after the current step';
  pauseBtn.classList.toggle('on', s.paused);
  drawSend();
  input.placeholder = placeholderFor(s);
  ask.hidden = s.pending === null;
  if (s.pending !== null) {
    el('ask-text', HTMLElement).innerHTML = renderMarkdown(cleanQuestion(s.pending));
    labelAsk(s.pendingLabels ?? null);
  }
}

/** Coalesces rapid incoming state transitions into a single animation frame paint. */
function scheduleApply(s: State): void {
  ingest(s.entries);
  pendingState = s;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!pendingState) return;
    const next = pendingState;
    pendingState = null;
    state = next;
    settings.setCurrentModel(next.model);
    modelPicker.setCurrent(next.model);
    banner.hidden = true;
    drawControls(next);
    drawStats(next);
    stats.update(next);
    drawSteps(next.todos);
    inspector.onBusy(next.busy, post);
    crew.drawCrew(next.helpers ?? [], logoSrc);
    drawConversation();
  });
}

function showBanner(text: string, kind: 'error' | 'info'): void {
  banner.hidden = false;
  banner.className = `banner ${kind}`;
  banner.innerHTML = `<span>${escapeHtml(text)}</span>${kind === 'info' ? '<button class="link" data-action="restart">Restart</button>' : ''}`;
}

// Track user-toggled `<details>` accordions so re-renders preserve their open state.
// Ignore events from nodes being detached: innerHTML replacement fires `toggle` closed.
conversation.addEventListener(
  'toggle',
  (e) => {
    const target = e.target;
    if (!(target instanceof HTMLDetailsElement) || !target.dataset.disclosureId) return;
    if (!target.isConnected) return;
    if (target.open) openDisclosures.add(target.dataset.disclosureId);
    else openDisclosures.delete(target.dataset.disclosureId);
  },
  true,
);

document.addEventListener('selectionchange', () => {
  if (!needsRedrawAfterSelect) return;
  if (hasActiveSelectionIn(blocksRoot)) return;
  needsRedrawAfterSelect = false;
  drawConversation();
});

window.addEventListener('message', (event: MessageEvent<Incoming>) => {
  if (event.origin && event.origin !== 'null' && event.origin !== window.location.origin) return;
  const m = event.data;
  if (m.type === 'ui') {
    runAction(m.action, null);
    return;
  }
  if (m.type === 'insert') {
    insertAtCaret(m.text);
    return;
  }
  if (m.type === 'files') {
    workspaceFiles = m.items;
    suggest.refresh();
    return;
  }
  if (m.type === 'browserFrame') {
    browserCockpit.drawFrame(m);
    return;
  }
  if (m.type === 'browserDiagnostics') {
    browserCockpit.drawDiagnostics(m);
    return;
  }
  if (m.type === 'browserVisual') {
    browserCockpit.drawVisual(m);
    return;
  }
  if (m.type === 'models')
    modelPicker.setModels(
      (m.items as modelPicker.ModelItem[] | undefined) ?? [],
      (m.unreachable as string[] | undefined) ?? [],
      typeof m.current === 'string' ? m.current : null,
    );
  if (m.type !== 'state' && inspector.onMessage(m)) return;
  if (m.type !== 'state' && contextPage.onMessage(m)) return;
  if (m.type !== 'state' && agentCard.onMessage(m)) return;
  if (m.type !== 'state' && posture.onMessage(m)) return;
  if (m.type !== 'state' && domain.onMessage(m)) return;
  if (m.type !== 'state' && settings.onMessage(m)) return;
  if (m.type === 'state') scheduleApply(m);
  else if (m.type === 'ready') {
    pendingState = null;
    lastLiveHtml = '';
    needsRedrawAfterSelect = false;
    settings.close();
    contextPage.close();
    inspector.close();
    crew.resetViews();
    browserCockpit.resetCockpit();
    blocks = [];
    logLines = [];
    openDisclosures.clear();
    lastStepsSignature = '';
    blocksRoot.replaceChildren();
    liveRoot.replaceChildren();
    drawConversation();
    agentCard.request(post);
  } else if (m.type === 'error' || m.type === 'down') {
    const text = typeof m.message === 'string' ? m.message : 'Something went wrong';
    showBanner(text, m.type === 'error' ? 'error' : 'info');
  }
});

/** While the agent works and the input is empty, Send is Stop. */
function drawSend(): void {
  const stop = Boolean(state?.busy) && !input.value.trim();
  send.classList.toggle('as-stop', stop);
  send.title = stop ? 'Stop (Esc)' : 'Send (Enter)';
  send.setAttribute('aria-label', stop ? 'Stop' : 'Send');
}

/** Sends the input. Only a click on the button (shown as Stop) stops a run; Enter never does. */
function submit(fromButton = false): void {
  const text = input.value.trim();
  if (!text) {
    if (fromButton && state?.busy) post({ type: 'stop' });
    return;
  }
  post({ type: 'send', text });
  if (sent.at(-1) !== text) sent.push(text);
  recall = -1;
  input.value = '';
  saveDraft();
  autosize();
  stick.conversation = true;
}

function saveDraft(): void {
  const prev = vscode.getState();
  vscode.setState({ ...(typeof prev === 'object' && prev ? prev : {}), draft: input.value });
}

function insertAtCaret(text: string): void {
  const at = input.selectionStart;
  const before = input.value.slice(0, at);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  fillInput(`${before}${pad}${text}${input.value.slice(input.selectionEnd)}`);
  saveDraft();
}

function fillInput(text: string): void {
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

/** ↑/↓ walk the messages sent this session while the composer is empty or showing one. */
function recallSent(dir: -1 | 1): boolean {
  if (!sent.length || (input.value && input.value !== sent[recall])) return false;
  const next = recall < 0 ? (dir < 0 ? sent.length - 1 : -1) : recall + dir;
  if (next < 0 || next >= sent.length) {
    recall = -1;
    fillInput('');
    return true;
  }
  recall = next;
  fillInput(sent[next] ?? '');
  return true;
}

/** Copies through the extension host (`vscode.env.clipboard`), which webviews can't block. */
function copyText(text: string, button: HTMLElement): void {
  post({ type: 'copy', text });
  button.classList.add('copied');
  setTimeout(() => {
    button.classList.remove('copied');
  }, 1200);
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${String(Math.min(input.scrollHeight, 200))}px`;
}

let workspaceFiles: readonly string[] = [];
const suggest = attachSuggest({
  input,
  box: el('suggest', HTMLElement),
  files: () => workspaceFiles,
  requestFiles: () => {
    post({ type: 'files' });
  },
  runCommand: (c) => {
    if ('mode' in c.run) post({ type: 'mode', mode: c.run.mode });
    else runAction(c.run.action, null);
  },
});
input.addEventListener('input', () => {
  autosize();
  saveDraft();
  drawSend();
  suggest.refresh();
});
input.addEventListener('click', () => {
  suggest.refresh();
});
input.addEventListener('dragover', (e) => {
  e.preventDefault();
});
input.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const list = [dt?.getData('text/uri-list'), dt?.getData('text/plain')].find(Boolean) ?? '';
  const uris = list
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter((u) => u && !u.startsWith('#'));
  if (!uris.length) return;
  e.preventDefault();
  post({ type: 'mention', uris });
});
input.addEventListener('blur', () => {
  el('suggest', HTMLElement).hidden = true;
});
input.addEventListener('keydown', (e) => {
  if (suggest.onKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.isComposing) {
    if (recallSent(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
  }
});
jumpBtn.addEventListener('click', () => {
  stick.conversation = true;
  jumpBtn.hidden = true;
  conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
});
window.addEventListener('focus', () => {
  if (!settings.isOpen() && !inspector.isOpen()) input.focus();
});
{
  const saved = vscode.getState() as { draft?: unknown } | undefined;
  if (typeof saved?.draft === 'string') fillInput(saved.draft);
}
send.addEventListener('click', () => {
  submit(true);
});
conversation.addEventListener(
  'scroll',
  () => {
    stick.conversation =
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
    if (stick.conversation) jumpBtn.hidden = true;
  },
  { passive: true },
);

/** A control's action, from a click in the panel or a command in the view's title bar. */
function runAction(action: string, target: Element | null): void {
  if (action === 'allow' || action === 'deny') post({ type: 'answer', yes: action === 'allow' });
  else if (action === 'approval') post({ type: 'yolo', on: !(state?.autoApprove ?? false) });
  else if (action === 'trace') post({ type: 'trace', on: !(state?.trace ?? false) });
  else if (action === 'pickModel') {
    const chip = target?.closest<HTMLElement>('[data-action]') ?? el('model', HTMLElement);
    if (modelPicker.isOpen()) modelPicker.close();
    else modelPicker.open(chip, post);
  } else if (action === 'inspect') {
    settings.close();
    contextPage.close();
    if (inspector.isOpen()) inspector.close();
    else inspector.open(post);
  } else if (action === 'settings') {
    contextPage.close();
    inspector.close();
    if (settings.isOpen()) settings.close();
    else settings.open(post);
  } else if (action) post({ type: action });
}

function toggleUsage(open: boolean): void {
  const pop = el('usage-pop', HTMLElement);
  pop.hidden = !open || !pop.hidden;
}

document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const mode = target.closest<HTMLElement>('[data-mode]')?.dataset.mode;
  if (mode) post({ type: 'mode', mode });
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (!target.closest('.pop')) toggleUsage(action === 'usage');
  if (action === 'usage') return;
  if (action) runAction(action, target);
  const path = target.closest<HTMLElement>('[data-open]')?.dataset.open;
  if (path) post({ type: 'open', path });
  const copyCode = target.closest<HTMLElement>('[data-copy-code]');
  const code = copyCode?.closest('pre')?.querySelector('code')?.textContent;
  if (copyCode && code) copyText(code, copyCode);
  const copyBlock = target.closest<HTMLElement>('[data-copy-block]');
  const reply = blocks.find((b) => String(b.id) === copyBlock?.dataset.copyBlock);
  if (copyBlock && reply) copyText(reply.lines.join('\n'), copyBlock);
  const reuse = target.closest<HTMLElement>('[data-reuse]')?.dataset.reuse;
  const mine = blocks.find((b) => String(b.id) === reuse);
  if (mine) fillInput(mine.lines.join('\n'));
  const suggestion = target.closest<HTMLElement>('[data-suggest]')?.dataset.suggest;
  if (suggestion) {
    input.value = suggestion;
    autosize();
    input.focus();
  }
});

document.addEventListener('keydown', (e) => {
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (e.key === 'Enter' && target?.dataset.open) post({ type: 'open', path: target.dataset.open });
  const asking = !el('ask', HTMLElement).hidden;
  if (asking && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    runAction('allow', null);
  } else if (asking && e.key === 'Escape') runAction('deny', null);
  else if (e.key === 'Escape' && !settings.isOpen() && !modelPicker.isOpen() && state?.busy)
    post({ type: 'stop' });
});

settings.useFoldStore({
  get: () => (vscode.getState() as { folded?: unknown } | undefined)?.folded,
  set: (folded) => {
    const prev = vscode.getState();
    vscode.setState({ ...(typeof prev === 'object' && prev ? prev : {}), folded });
  },
});
settings.wire(post);
agentCard.wire(post);
posture.wire(post);
posture.request(post);
domain.wire(post);
domain.request(post);
contextPage.wire(post);
inspector.wire(post, () => {
  contextPage.open(post);
});
browserCockpit.wireCockpit();
modelPicker.wire(() => {
  settings.open(post);
});
setInterval(() => {
  drawUptime();
  const eta = document.getElementById('eta');
  if (eta) eta.textContent = etaText(state?.waiting, Date.now());
}, CLOCK_TICK_MS);
post({ type: 'ready' });
input.focus();

/** An offer (pull a model) names its own buttons; guard questions keep Allow / Deny. */
function labelAsk(labels: { yes: string; no: string } | null): void {
  el('ask-title', HTMLElement).textContent = labels ? 'Set up a local model' : 'Approval needed';
  el('ask-yes', HTMLElement).textContent = labels?.yes ?? 'Allow';
  el('ask-no', HTMLElement).textContent = labels?.no ?? 'Deny';
}
