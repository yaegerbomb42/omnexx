/**
 * The context inspector: everything the next request sends the model (system prompt, tool
 * definitions incl. MCP and skills, your notes, chat history), item by item with token counts and
 * a bar against the context budget. System blocks and tools can be edited, hidden and restored;
 * chat items edited, deleted or pinned (kept as a note); notes added, edited and deleted.
 * Offers a one-click "Clear All History" action that clears conversation messages and tooling history,
 * keeping only the system prompt and tools intact.
 */
import { escapeHtml, formatTokens } from './render.js';

type Post = (msg: Record<string, unknown>) => void;
type Group = 'system' | 'tools' | 'notes' | 'chat';

export interface ContextItem {
  id: string;
  group: Group;
  label: string;
  source?: string;
  text: string;
  tokens: number;
  edited: boolean;
  removed: boolean;
  editable: boolean;
}

const GROUPS: {
  id: Group;
  title: string;
  about: string;
  badge: string;
  icon: string;
}[] = [
  {
    id: 'system',
    title: 'System Prompt & Instructions',
    about: 'Base instructions, repo map, guidelines and rules',
    badge: 'Core System',
    icon: '⚡',
  },
  {
    id: 'tools',
    title: 'Registered Tooling',
    about: 'Built-in functions, CLI tooling, and active MCP servers',
    badge: 'Tools',
    icon: '🛠️',
  },
  {
    id: 'notes',
    title: 'Notes & Directives',
    about: 'Direct human guidance and pinned insights',
    badge: 'Notes',
    icon: '📌',
  },
  {
    id: 'chat',
    title: 'Conversation & Tool History',
    about: 'Step turns, messages, tool execution logs and results',
    badge: 'History',
    icon: '💬',
  },
];

let items: ContextItem[] = [];
let busy = false;
/** The context budget the chat compacts at (0: unknown). */
let budget = 0;
/** The add-a-note box is open. */
let adding = false;
let loading = true;
/** The item being edited, if any. */
let editing: string | null = null;
/** Items the user opened, kept across redraws. */
let opened = new Set<string>();

function page(): HTMLElement {
  const el = document.getElementById('inspector');
  if (!el) throw new Error('missing #inspector');
  return el;
}

const sum = (list: readonly ContextItem[]): number =>
  list.filter((i) => !i.removed).reduce((n, i) => n + i.tokens, 0);

function button(label: string, attr: string, id: string, danger = false): string {
  return `<button class="ci-btn ${danger ? 'ci-btn-danger' : 'ci-btn-ghost'}" ${attr}="${escapeHtml(id)}"${busy ? ' disabled' : ''}>${label}</button>`;
}

/** Edit for text; Hide / Restore for the defaults; Delete and Pin for chat; Delete for notes. */
function actionsHtml(i: ContextItem): string {
  const fixed = i.group === 'system' || i.group === 'tools';
  return [
    i.editable && !i.removed ? button('Edit', 'data-ci-edit', i.id) : '',
    i.group === 'chat' ? button('Pin as Note', 'data-ci-pin', i.id) : '',
    fixed && (i.removed || i.edited) ? button('Restore', 'data-ci-restore', i.id) : '',
    fixed && !i.removed ? button('Hide', 'data-ci-delete', i.id) : '',
    !fixed ? button('Delete', 'data-ci-delete', i.id, true) : '',
  ].join('');
}

function budgetHtml(): string {
  const used = sum(items);
  const chatTokens = sum(items.filter((i) => i.group === 'chat'));
  const sysTokens = sum(items.filter((i) => i.group === 'system'));
  const toolTokens = sum(items.filter((i) => i.group === 'tools'));
  const noteTokens = sum(items.filter((i) => i.group === 'notes'));

  const budgetMax = budget > 0 ? budget : Math.max(1, used * 1.25);
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 100;

  const sysPct = Math.min(100, (sysTokens / budgetMax) * 100);
  const toolPct = Math.min(100, (toolTokens / budgetMax) * 100);
  const notePct = Math.min(100, (noteTokens / budgetMax) * 100);
  const chatPct = Math.min(100, (chatTokens / budgetMax) * 100);

  const meter = `<div class="ci-meter" role="meter" aria-valuemin="0" aria-valuemax="${String(budgetMax)}" aria-valuenow="${String(used)}" aria-label="Context used">
    <i class="ci-m-system" style="width:${String(sysPct)}%" title="System: ${formatTokens(sysTokens)} tok"></i>
    <i class="ci-m-tools" style="width:${String(toolPct)}%" title="Tools: ${formatTokens(toolTokens)} tok"></i>
    <i class="ci-m-notes" style="width:${String(notePct)}%" title="Notes: ${formatTokens(noteTokens)} tok"></i>
    <i class="ci-m-chat" style="width:${String(chatPct)}%" title="Chat: ${formatTokens(chatTokens)} tok"></i>
  </div>`;

  return `
    <div class="ci-budget-summary">
      <div class="ci-budget-title">
        <span class="ci-budget-badge">⚡ Active Context Window</span>
        <span class="ci-budget-count"><b>${formatTokens(used)}</b>${budget > 0 ? ` / ${formatTokens(budget)}` : ''} tok (${pct}%)</span>
      </div>
      ${meter}
      <div class="ci-budget-legend">
        <span class="ci-leg-item ci-leg-system"><i class="ci-dot"></i>System: <b>${formatTokens(sysTokens)}</b></span>
        <span class="ci-leg-item ci-leg-tools"><i class="ci-dot"></i>Tools: <b>${formatTokens(toolTokens)}</b></span>
        <span class="ci-leg-item ci-leg-notes"><i class="ci-dot"></i>Notes: <b>${formatTokens(noteTokens)}</b></span>
        <span class="ci-leg-item ci-leg-chat"><i class="ci-dot"></i>History: <b>${formatTokens(chatTokens)}</b></span>
      </div>
    </div>`;
}

function addNoteHtml(): string {
  return adding
    ? `<div class="ci-note-form">
        <textarea class="ci-edit" data-ci-note rows="3" placeholder="Enter custom prompt rule or persistent instruction..."></textarea>
        <div class="ci-actions">
          <button class="ci-btn ci-btn-primary" data-ci-note-save>Save Directive</button>
          <button class="ci-btn ci-btn-ghost" data-ci-cancel>Cancel</button>
        </div>
      </div>`
    : `<div class="ci-actions"><button class="ci-btn ci-btn-secondary" data-ci-note-open${busy ? ' disabled' : ''}>+ Add Custom Directive / Note</button></div>`;
}

function itemHtml(i: ContextItem): string {
  const id = escapeHtml(i.id);
  const flags = `${i.edited && !i.removed ? '<span class="ci-pill ci-pill-warn">edited</span>' : ''}${i.removed ? '<span class="ci-pill ci-pill-off">hidden</span>' : ''}`;
  const body =
    editing === i.id
      ? `<textarea class="ci-edit" data-ci-text="${id}" rows="8">${escapeHtml(i.text)}</textarea>
<div class="ci-actions"><button class="ci-btn ci-btn-primary" data-ci-save="${id}">Save</button><button class="ci-btn ci-btn-ghost" data-ci-cancel>Cancel</button></div>`
      : `<pre class="ci-text">${escapeHtml(i.text)}</pre>
<div class="ci-actions">${actionsHtml(i)}</div>`;
  const open = opened.has(i.id) || editing === i.id ? ' open' : '';
  const src = i.source ? `<span class="ci-src">${escapeHtml(i.source)}</span>` : '';
  return `<li class="ci-card-item${i.removed ? ' removed' : ''}">
    <details data-ci="${id}"${open}>
      <summary class="ci-item-summary">
        <div class="ci-item-left">
          <span class="ci-label">${escapeHtml(i.label)}</span>
          ${src}
          ${flags}
        </div>
        <div class="ci-item-right">
          <span class="ci-tok-pill">${formatTokens(i.tokens)} tok</span>
        </div>
      </summary>
      <div class="ci-item-body">${body}</div>
    </details>
  </li>`;
}

function groupHtml(g: (typeof GROUPS)[number]): string {
  const list = items.filter((i) => i.group === g.id);
  const listHtml = list.length
    ? `<ul class="ci-cards-list">${list.map(itemHtml).join('')}</ul>`
    : `<div class="ci-empty-container">
        <span>No ${g.title.toLowerCase()} currently active.</span>
      </div>`;
  const extra = g.id === 'notes' ? addNoteHtml() : '';
  const groupTokens = sum(list);

  return `
    <div class="ci-container-card ci-group-${g.id}">
      <details class="ci-group-details" open>
        <summary class="ci-group-header">
          <div class="ci-group-left">
            <span class="ci-group-icon">${g.icon}</span>
            <div class="ci-group-meta">
              <div class="ci-group-title-row">
                <span class="ci-group-title">${g.title}</span>
                <span class="ci-group-badge">${g.badge}</span>
              </div>
              <span class="ci-group-about">${g.about}</span>
            </div>
          </div>
          <div class="ci-group-right">
            <span class="ci-group-tokens"><b>${formatTokens(groupTokens)}</b> tok</span>
            <span class="ci-group-count">${list.length} item${list.length === 1 ? '' : 's'}</span>
          </div>
        </summary>
        <div class="ci-group-content">
          ${listHtml}
          ${extra}
        </div>
      </details>
    </div>`;
}

function draw(): void {
  const el = page();
  const head = `
    <div class="set-head ci-nav-header">
      <button class="ci-btn ci-btn-ghost back" data-ci-close>← Back to chat</button>
      <div class="ci-head-titles">
        <h2>Context Cockpit</h2>
        <span class="ci-sub">Token allocations, model payloads, and memory controls</span>
      </div>
    </div>`;

  if (loading) {
    el.innerHTML = `${head}<div class="ci-loading-state"><span class="spinner"></span> Reading context components…</div>`;
    return;
  }

  const empty = items.length === 0;
  const hasChat = items.some((i) => i.group === 'chat');

  el.innerHTML = `
    ${head}
    <div class="ci-cockpit-shell">
      <div class="ci-top-panel">
        ${budgetHtml()}
        <div class="ci-action-toolbar">
          <button class="ci-btn ci-btn-clear-chat" data-ci-clear-chat${busy || !hasChat ? ' disabled' : ''} title="Purge conversation history & tool outputs, keeping system prompt and tools intact">
            <span class="ci-btn-icon">🗑️</span> Clear Chat &amp; Tool History
          </button>
          <button class="ci-btn ci-btn-secondary" data-ci-reset${busy || empty ? ' disabled' : ''} title="Restore default system prompts and tools">
            Restore Defaults
          </button>
          <button class="ci-btn ci-btn-secondary" data-ci-files title="Browse repository context files">
            Files &amp; Sections
          </button>
        </div>
      </div>

      <div class="ci-banner-hint">
        <span class="ci-banner-icon">ℹ️</span>
        <div class="ci-banner-text">
          ${busy ? '<b>Agent is running:</b> Edits unlock when the turn concludes. ' : ''}
          Edits apply to the next request. <b>Clear Chat &amp; Tool History</b> removes past conversation turns, restoring a clean prompt with 100% warm prefix system &amp; tool state.
        </div>
      </div>

      <div class="ci-containers-flow">
        ${empty ? '<div class="ci-empty-notice">Context initializes upon your first interaction or repo start.</div>' : GROUPS.map(groupHtml).join('')}
      </div>
    </div>`;
}

export function isOpen(): boolean {
  return !page().hidden;
}

export function open(post: Post): void {
  document.body.classList.add('inspect-open');
  page().hidden = false;
  loading = items.length === 0;
  editing = null;
  draw();
  post({ type: 'contextList' });
}

export function close(): void {
  document.body.classList.remove('inspect-open');
  page().hidden = true;
  editing = null;
}

/** A turn started or ended while the inspector is open: lock edits, then show the new context. */
export function onBusy(nowBusy: boolean, post: Post): void {
  if (nowBusy === busy || !isOpen()) return;
  busy = nowBusy;
  if (!nowBusy) post({ type: 'contextList' });
  else draw();
}

export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'contextItems') return false;
  items = Array.isArray(m.items) ? (m.items as ContextItem[]) : [];
  busy = m.busy === true;
  budget = typeof m.budget === 'number' ? m.budget : budget;
  loading = false;
  if (editing && !items.some((i) => i.id === editing)) editing = null;
  if (isOpen()) draw();
  return true;
}

function handleClick(t: Element, post: Post, openFiles: () => void): void {
  const edit = t.closest<HTMLElement>('[data-ci-edit]')?.dataset.ciEdit;
  const del = t.closest<HTMLElement>('[data-ci-delete]')?.dataset.ciDelete;
  const save = t.closest<HTMLElement>('[data-ci-save]')?.dataset.ciSave;
  const pin = t.closest<HTMLElement>('[data-ci-pin]')?.dataset.ciPin;
  const restore = t.closest<HTMLElement>('[data-ci-restore]')?.dataset.ciRestore;

  if (t.closest('[data-ci-close]')) close();
  else if (t.closest('[data-ci-files]')) {
    close();
    openFiles();
  } else if (t.closest('[data-ci-clear-chat]')) {
    post({ type: 'contextClearChat' });
  } else if (t.closest('[data-ci-reset]')) {
    post({ type: 'contextReset' });
  } else if (t.closest('[data-ci-note-open]')) {
    adding = true;
    draw();
    page().querySelector<HTMLTextAreaElement>('textarea[data-ci-note]')?.focus();
  } else if (t.closest('[data-ci-note-save]')) {
    const text = page().querySelector<HTMLTextAreaElement>('textarea[data-ci-note]')?.value ?? '';
    adding = false;
    if (text.trim()) post({ type: 'contextAdd', text });
    else draw();
  } else if (pin) {
    post({ type: 'contextPin', id: pin });
  } else if (restore) {
    post({ type: 'contextRestore', id: restore });
  } else if (t.closest('[data-ci-cancel]')) {
    editing = null;
    adding = false;
    draw();
  } else if (edit) {
    editing = edit;
    draw();
  } else if (del) {
    post({ type: 'contextDelete', id: del });
  } else if (save) {
    const area = page().querySelector<HTMLTextAreaElement>('textarea[data-ci-text]');
    editing = null;
    post({ type: 'contextUpdate', id: save, text: area?.value ?? '' });
  }
}

export function wire(post: Post, openFiles: () => void): void {
  page().addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t) handleClick(t, post, openFiles);
  });
  // Remember which items are open, so a refresh doesn't fold them back.
  page().addEventListener(
    'toggle',
    (e) => {
      const id = e.target instanceof HTMLElement ? e.target.dataset.ci : undefined;
      if (!id) return;
      const next = new Set(opened);
      if ((e.target as HTMLDetailsElement).open) next.add(id);
      else next.delete(id);
      opened = next;
    },
    true,
  );
  page().addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editing) close();
  });
}
