/**
 * The context inspector: everything the next request sends the model (system prompt, tool
 * definitions incl. MCP and skills, your notes, chat history), item by item with token counts and
 * a bar against the context budget. System blocks and tools can be edited, hidden and restored;
 * chat items edited, deleted or pinned (kept as a note); notes added, edited and deleted.
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

const GROUPS: { id: Group; title: string; about: string }[] = [
  { id: 'system', title: 'System prompt', about: 'Instructions, project notes and the repo map' },
  { id: 'tools', title: 'Tools', about: 'Built-in, MCP and the skills catalog' },
  { id: 'notes', title: 'Your notes', about: 'Added by you or pinned from the chat' },
  { id: 'chat', title: 'Chat history', about: 'Messages, tool calls and their results' },
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
  return `<button class="ghost small${danger ? ' danger' : ''}" ${attr}="${escapeHtml(id)}"${busy ? ' disabled' : ''}>${label}</button>`;
}

/** Edit for text; Hide / Restore for the defaults; Delete and Pin for chat; Delete for notes. */
function actionsHtml(i: ContextItem): string {
  const fixed = i.group === 'system' || i.group === 'tools';
  return [
    i.editable && !i.removed ? button('Edit', 'data-ci-edit', i.id) : '',
    i.group === 'chat' ? button('Pin', 'data-ci-pin', i.id) : '',
    fixed && (i.removed || i.edited) ? button('Restore', 'data-ci-restore', i.id) : '',
    fixed && !i.removed ? button('Hide', 'data-ci-delete', i.id) : '',
    !fixed ? button('Delete', 'data-ci-delete', i.id, true) : '',
  ].join('');
}

function budgetHtml(): string {
  const used = sum(items);
  if (budget <= 0) return `<span><b>${formatTokens(used)}</b> tokens sent next turn</span>`;
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const parts = GROUPS.map((g) => {
    const share = (sum(items.filter((i) => i.group === g.id)) / budget) * 100;
    return `<i class="ci-m-${g.id}" style="width:${String(Math.min(100, share))}%" title="${g.title}"></i>`;
  }).join('');
  return `<span><b>${formatTokens(used)}</b> of ${formatTokens(budget)} tokens (${String(pct)}%) sent next turn</span><div class="ci-meter" role="meter" aria-valuemin="0" aria-valuemax="${String(budget)}" aria-valuenow="${String(used)}" aria-label="Context used">${parts}</div>`;
}

function addNoteHtml(): string {
  return adding
    ? `<textarea class="ci-edit" data-ci-note rows="4" placeholder="Something the agent should always know"></textarea>
<div class="ci-actions"><button class="primary small" data-ci-note-save>Add</button><button class="ghost small" data-ci-cancel>Cancel</button></div>`
    : `<div class="ci-actions"><button class="ghost small" data-ci-note-open${busy || items.length === 0 ? ' disabled' : ''}>+ Add a note</button></div>`;
}

function itemHtml(i: ContextItem): string {
  const id = escapeHtml(i.id);
  const flags = `${i.edited && !i.removed ? '<span class="ci-flag">edited</span>' : ''}${i.removed ? '<span class="ci-flag off">hidden</span>' : ''}`;
  const body =
    editing === i.id
      ? `<textarea class="ci-edit" data-ci-text="${id}" rows="8">${escapeHtml(i.text)}</textarea>
<div class="ci-actions"><button class="primary small" data-ci-save="${id}">Save</button><button class="ghost small" data-ci-cancel>Cancel</button></div>`
      : `<pre class="ci-text">${escapeHtml(i.text)}</pre>
<div class="ci-actions">${actionsHtml(i)}</div>`;
  const open = opened.has(i.id) || editing === i.id ? ' open' : '';
  const src = i.source ? `<span class="ci-src">${escapeHtml(i.source)}</span>` : '';
  return `<li class="ci${i.removed ? ' removed' : ''}"><details data-ci="${id}"${open}><summary><span class="ci-label">${escapeHtml(i.label)}</span>${src}${flags}<span class="ci-tok">${formatTokens(i.tokens)}</span></summary>${body}</details></li>`;
}

function groupHtml(g: (typeof GROUPS)[number]): string {
  const list = items.filter((i) => i.group === g.id);
  const listHtml = list.length
    ? `<ul class="ci-list">${list.map(itemHtml).join('')}</ul>`
    : '<p class="hint">Nothing yet.</p>';
  const rows = `${listHtml}${g.id === 'notes' ? addNoteHtml() : ''}`;
  return `<details class="ci-group" open><summary><span class="chev" aria-hidden="true"></span><span class="h">${g.title}</span><span class="sub-h">${list.length} · ${g.about}</span><span class="count">${formatTokens(sum(list))}</span></summary>${rows}</details>`;
}

function draw(): void {
  const el = page();
  const head = `<div class="set-head"><button class="ghost back" data-ci-close>← Back to chat</button><h2>Context</h2></div>`;
  if (loading) {
    el.innerHTML = `${head}<p class="hint"><span class="spinner"></span> Reading the context…</p>`;
    return;
  }
  const empty = items.length === 0;
  el.innerHTML = `${head}
<div class="ci-bar">${budgetHtml()}<button class="ghost small" data-ci-reset${busy || empty ? ' disabled' : ''}>Restore defaults</button><button class="ghost small" data-ci-files>Files &amp; sections</button></div>
<p class="hint ci-note">${busy ? 'The agent is working: edits unlock when it stops. ' : ''}Edits apply to the next message. Changing the system prompt, tools or early messages invalidates the prompt cache, so the next request costs more.</p>
${empty ? '<p class="hint">Send a message first: the context exists once a chat is open.</p>' : GROUPS.map(groupHtml).join('')}`;
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
  } else if (t.closest('[data-ci-reset]')) post({ type: 'contextReset' });
  else if (t.closest('[data-ci-note-open]')) {
    adding = true;
    draw();
    page().querySelector<HTMLTextAreaElement>('textarea[data-ci-note]')?.focus();
  } else if (t.closest('[data-ci-note-save]')) {
    const text = page().querySelector<HTMLTextAreaElement>('textarea[data-ci-note]')?.value ?? '';
    adding = false;
    if (text.trim()) post({ type: 'contextAdd', text });
    else draw();
  } else if (pin) post({ type: 'contextPin', id: pin });
  else if (restore) post({ type: 'contextRestore', id: restore });
  else if (t.closest('[data-ci-cancel]')) {
    editing = null;
    adding = false;
    draw();
  } else if (edit) {
    editing = edit;
    draw();
  } else if (del) post({ type: 'contextDelete', id: del });
  else if (save) {
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
