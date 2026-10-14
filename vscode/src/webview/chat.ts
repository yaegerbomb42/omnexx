/**
 * The chat panel's script (runs inside the webview). It draws what the extension forwards from
 * `omnexx chat-server` and posts the person's actions back; it never talks to omnexx itself.
 *
 * Layout, top to bottom: session stats, the step timeline (the agent's todo list), the
 * conversation, the live log (actions, thinking, notes), and the composer.
 */
import {
  addEntries,
  cacheHitPercent,
  cleanQuestion,
  contextPercent,
  escapeHtml,
  formatClock,
  formatTokens,
  formatUsd,
  logRole,
  renderMarkdown,
  stepLabel,
  stepStates,
  stepsPercent,
  type Block,
  type Entry,
  type TodoItem,
  type Usage,
} from './render.js';
import * as contextPage from './contextPage.js';
import * as crew from './crew.js';
import * as modelPicker from './modelPicker.js';
import * as settings from './settings.js';

interface State {
  entries: Entry[];
  live: string;
  todos: TodoItem[];
  pending: string | null;
  mode: 'chat' | 'plan' | 'run';
  busy: boolean;
  paused: boolean;
  autoApprove: boolean;
  model: string | null;
  context: {
    used: number;
    limit: number;
    parts?: { system: number; tools: number; conversation: number };
  } | null;
  usage: (Usage & { startedAt: number | null }) | null;
  helpers?: crew.Helper[];
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
        | 'browser';
    } & Record<string, unknown>)
  | ({ type: 'browserFrame' } & crew.BrowserFrameMsg)
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }
  | { type: 'down'; message: string };

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface LogLine {
  at: number;
  role: NonNullable<ReturnType<typeof logRole>>;
  text: string;
}

const MAX_LOG_LINES = 400;
const ACTIVE_STEP_ACTIONS = 2;
const CLOCK_TICK_MS = 1_000;

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
const stopBtn = el('stop', HTMLButtonElement);
const ask = el('ask', HTMLElement);
const steps = el('steps', HTMLElement);
const stepsBody = el('steps-body', HTMLElement);
const liveLog = el('live-log', HTMLElement);
const banner = el('banner', HTMLElement);
const welcome = el('welcome', HTMLElement);
/** The head agent's avatar in the crew view: the logo the header already shows. */
const logoSrc = document.querySelector<HTMLImageElement>('.brand .logo')?.src ?? '';

let blocks: Block[] = [];
let logLines: LogLine[] = [];
let state: State | undefined;
/** Keep a scroller pinned to the bottom unless the person scrolled up to read. */
const stick = { conversation: true, log: true };

const ICON = {
  check:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spinner: '<span class="spinner" aria-hidden="true"></span>',
  wait: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  dot: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};

/** 12-hour clock for the live log, e.g. "3:04:05 PM". */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Messages stay in the conversation; everything else goes to the live log. */
function ingest(entries: readonly Entry[]): void {
  const now = Date.now();
  const forLog: LogLine[] = [];
  const forChat: Entry[] = [];
  for (const e of entries) {
    const role = logRole(e.kind);
    if (role) forLog.push({ at: now, role, text: e.text.trim() });
    // Errors show in both places: they need attention where the person is reading.
    if (!role || role === 'error') forChat.push(e);
  }
  blocks = addEntries(blocks, forChat);
  logLines = [...logLines, ...forLog.filter((l) => l.text)].slice(-MAX_LOG_LINES);
}

function messageHtml(b: Block): string {
  const body = b.lines.join('\n');
  if (b.kind === 'out') return `<div class="msg reply">${renderMarkdown(body)}</div>`;
  if (b.kind === 'user')
    return `<div class="msg user"><div class="who">You</div><div class="text">${escapeHtml(body)}</div></div>`;
  const text = b.lines.map((l) => l.trimStart().replace(/^✗ ?/, '')).join('\n');
  return `<div class="msg error">${escapeHtml(text)}</div>`;
}

function drawConversation(): void {
  welcome.hidden = blocks.length > 0 || Boolean(state?.live) || Boolean(state?.busy);
  const html = blocks.map(messageHtml);
  if (state?.live)
    html.push(`<div class="msg reply streaming">${renderMarkdown(state.live)}</div>`);
  if (state?.busy && !state.live && !state.pending) {
    const doing = logLines.findLast((l) => l.role === 'agent')?.text ?? 'Thinking';
    html.push(
      `<div class="working">${ICON.spinner}<span>${escapeHtml(doing)}</span>${state.paused ? '<span class="tag">paused</span>' : ''}</div>`,
    );
  }
  conversation.innerHTML = html.join('');
  if (stick.conversation) conversation.scrollTop = conversation.scrollHeight;
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
  if (!items.length) return;
  const states = stepStates(items);
  const pct = stepsPercent(items);
  const done = items.filter((t) => t.status === 'done').length;
  el('steps-count', HTMLElement).textContent = `${String(done)}/${String(items.length)}`;
  const recent = logLines
    .filter((l) => l.role === 'agent')
    .slice(-ACTIVE_STEP_ACTIONS)
    .map((l) => `<li>${escapeHtml(l.text)}</li>`)
    .join('');
  const icons = { done: ICON.check, active: ICON.spinner, waiting: ICON.wait, queued: ICON.dot };
  stepsBody.innerHTML = items
    .map((t, i) => {
      const s = states[i] ?? 'queued';
      return `<li class="step ${s}"><span class="node" aria-hidden="true"></span><div class="card"><div class="title"><span class="icon">${icons[s]}</span><span class="label">${stepLabel(i)}:</span><span class="text">${escapeHtml(t.text)}</span></div>${stepDetail(s, states, pct, recent)}</div></li>`;
    })
    .join('');
}

function drawLiveLog(): void {
  liveLog.innerHTML = logLines.length
    ? logLines
        .map(
          (l) =>
            `<div class="line ${l.role}"><span class="ts">[${clock(l.at)}]</span> <span class="role">${l.role.toUpperCase()}:</span> ${escapeHtml(l.text)}</div>`,
        )
        .join('')
    : '<div class="line empty">Actions, thinking and notes show here as the agent works.</div>';
  if (stick.log) liveLog.scrollTop = liveLog.scrollHeight;
}

function stat(id: string, value: string, title: string): void {
  const node = el(id, HTMLElement);
  node.textContent = value;
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
  drawUptime();
  const pct = contextPercent(s.context);
  const fill = el('ctx-fill', HTMLElement);
  fill.style.width = `${String(pct)}%`;
  fill.classList.toggle('hot', pct > 85);
  el('ctx-text', HTMLElement).textContent = s.context
    ? `${formatTokens(s.context.used)} / ${formatTokens(s.context.limit)}`
    : '—';
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
  return s.busy ? 'Steer the agent (e.g. "use the existing helper")…' : 'Message omnexx…';
}

function drawControls(s: State): void {
  el('model', HTMLButtonElement).textContent = s.model ?? 'Pick a model';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))
    b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode));
  const approval = el('approval', HTMLButtonElement);
  approval.textContent = s.autoApprove ? 'Auto-approve' : 'Ask first';
  approval.classList.toggle('danger', s.autoApprove);
  approval.title = s.autoApprove
    ? 'omnexx goes ahead without asking (hard-blocked commands stay blocked). Click to ask first.'
    : 'omnexx asks before going outside the repo or running guarded commands. Click to auto-approve.';
  pauseBtn.disabled = !s.busy;
  pauseBtn.dataset.action = s.paused ? 'resume' : 'pause';
  pauseBtn.title = s.paused ? 'Resume' : 'Pause after the current step';
  pauseBtn.classList.toggle('on', s.paused);
  stopBtn.disabled = !s.busy;
  input.placeholder = placeholderFor(s);
  ask.hidden = s.pending === null;
  if (s.pending !== null)
    el('ask-text', HTMLElement).innerHTML = renderMarkdown(cleanQuestion(s.pending));
}

function apply(s: State): void {
  ingest(s.entries);
  state = s;
  settings.setCurrentModel(s.model);
  modelPicker.setCurrent(s.model);
  banner.hidden = true;
  drawControls(s);
  drawStats(s);
  drawSteps(s.todos);
  // An older omnexx sends no helpers; treat that as none.
  crew.drawCrew(s.helpers ?? [], logoSrc);
  drawLiveLog();
  drawConversation();
}

function showBanner(text: string, kind: 'error' | 'info'): void {
  banner.hidden = false;
  banner.className = `banner ${kind}`;
  banner.innerHTML = `<span>${escapeHtml(text)}</span>${kind === 'info' ? '<button class="link" data-action="restart">Restart</button>' : ''}`;
}

window.addEventListener('message', (event: MessageEvent<Incoming>) => {
  // The extension's messages arrive through VS Code's webview host, which shares this frame's
  // origin; anything else (another frame or window) is ignored.
  if (event.origin !== window.location.origin) return;
  const m = event.data;
  if (m.type === 'browserFrame') {
    crew.drawBrowser(m);
    return;
  }
  if (m.type === 'models')
    modelPicker.setModels(
      (m.items as modelPicker.ModelItem[] | undefined) ?? [],
      (m.unreachable as string[] | undefined) ?? [],
      typeof m.current === 'string' ? m.current : null,
    );
  if (m.type !== 'state' && contextPage.onMessage(m)) return;
  if (m.type !== 'state' && settings.onMessage(m)) return;
  if (m.type === 'state') apply(m);
  else if (m.type === 'ready') {
    // A new chat, a fresh omnexx process or a resync: back to the conversation, from the start.
    settings.close();
    contextPage.close();
    crew.resetViews();
    blocks = [];
    logLines = [];
    drawConversation();
    drawLiveLog();
  } else if (m.type === 'error' || m.type === 'down') {
    const text = typeof m.message === 'string' ? m.message : 'Something went wrong';
    showBanner(text, m.type === 'error' ? 'error' : 'info');
  }
});

function submit(): void {
  const text = input.value.trim();
  if (!text) return;
  post({ type: 'send', text });
  input.value = '';
  autosize();
  stick.conversation = true;
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${String(Math.min(input.scrollHeight, 200))}px`;
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
send.addEventListener('click', submit);
conversation.addEventListener('scroll', () => {
  stick.conversation =
    conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
});
liveLog.addEventListener('scroll', () => {
  stick.log = liveLog.scrollHeight - liveLog.scrollTop - liveLog.clientHeight < 24;
});

document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const mode = target.closest<HTMLElement>('[data-mode]')?.dataset.mode;
  if (mode) post({ type: 'mode', mode });
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'allow' || action === 'deny') post({ type: 'answer', yes: action === 'allow' });
  else if (action === 'approval') post({ type: 'yolo', on: !(state?.autoApprove ?? false) });
  else if (action === 'pickModel') {
    const chip = target.closest<HTMLElement>('[data-action]');
    if (modelPicker.isOpen()) modelPicker.close();
    else if (chip) modelPicker.open(chip, post);
  } else if (action === 'context') {
    settings.close();
    if (contextPage.isOpen()) contextPage.close();
    else contextPage.open(post);
  } else if (action === 'settings') {
    contextPage.close();
    if (settings.isOpen()) settings.close();
    else settings.open(post);
  } else if (action === 'clear-log') {
    logLines = [];
    drawLiveLog();
  } else if (action) post({ type: action });
  const path = target.closest<HTMLElement>('[data-open]')?.dataset.open;
  if (path) post({ type: 'open', path });
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
  if (e.key === 'Escape' && !settings.isOpen() && !modelPicker.isOpen() && state?.busy)
    post({ type: 'stop' });
});

settings.wire(post);
contextPage.wire(post);
crew.wire();
modelPicker.wire(() => {
  settings.open(post);
});
setInterval(drawUptime, CLOCK_TICK_MS);
post({ type: 'ready' });
input.focus();
