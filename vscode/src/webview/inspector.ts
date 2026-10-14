/**
 * The context inspector: everything the next request sends the model (system prompt, tool
 * definitions, chat history), item by item with token counts. Each item opens to show its text,
 * and can be edited or deleted; Restore defaults brings back the system prompt and tools.
 */
import { escapeHtml, formatTokens } from './render.js';

type Post = (msg: Record<string, unknown>) => void;
type Group = 'system' | 'tools' | 'chat';

export interface ContextItem {
  id: string;
  group: Group;
  label: string;
  text: string;
  tokens: number;
  edited: boolean;
  removed: boolean;
  editable: boolean;
}

const GROUPS: { id: Group; title: string; about: string }[] = [
  { id: 'system', title: 'System prompt', about: 'Instructions, project notes and the repo map' },
  { id: 'tools', title: 'Tools', about: 'Definitions the model can call' },
  { id: 'chat', title: 'Chat history', about: 'Messages, tool calls and their results' },
];

let items: ContextItem[] = [];
let busy = false;
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

function itemHtml(i: ContextItem): string {
  const id = escapeHtml(i.id);
  const flags = `${i.edited && !i.removed ? '<span class="ci-flag">edited</span>' : ''}${i.removed ? '<span class="ci-flag off">hidden</span>' : ''}`;
  const body =
    editing === i.id
      ? `<textarea class="ci-edit" data-ci-text="${id}" rows="8">${escapeHtml(i.text)}</textarea>
<div class="ci-actions"><button class="primary small" data-ci-save="${id}">Save</button><button class="ghost small" data-ci-cancel>Cancel</button></div>`
      : `<pre class="ci-text">${escapeHtml(i.text)}</pre>
<div class="ci-actions">${i.editable && !i.removed ? `<button class="ghost small" data-ci-edit="${id}"${busy ? ' disabled' : ''}>Edit</button>` : ''}${i.removed ? '' : `<button class="ghost small danger" data-ci-delete="${id}"${busy ? ' disabled' : ''}>Delete</button>`}</div>`;
  const open = opened.has(i.id) || editing === i.id ? ' open' : '';
  return `<li class="ci${i.removed ? ' removed' : ''}"><details data-ci="${id}"${open}><summary><span class="ci-label">${escapeHtml(i.label)}</span>${flags}<span class="ci-tok">${formatTokens(i.tokens)}</span></summary>${body}</details></li>`;
}

function groupHtml(g: (typeof GROUPS)[number]): string {
  const list = items.filter((i) => i.group === g.id);
  const rows = list.length
    ? `<ul class="ci-list">${list.map(itemHtml).join('')}</ul>`
    : '<p class="hint">Nothing yet.</p>';
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
<div class="ci-bar"><span><b>${formatTokens(sum(items))}</b> tokens sent next turn</span><button class="ghost small" data-ci-reset${busy || empty ? ' disabled' : ''}>Restore defaults</button><button class="ghost small" data-ci-files>Files &amp; sections</button></div>
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
  loading = false;
  if (editing && !items.some((i) => i.id === editing)) editing = null;
  if (isOpen()) draw();
  return true;
}

function handleClick(t: Element, post: Post, openFiles: () => void): void {
  const edit = t.closest<HTMLElement>('[data-ci-edit]')?.dataset.ciEdit;
  const del = t.closest<HTMLElement>('[data-ci-delete]')?.dataset.ciDelete;
  const save = t.closest<HTMLElement>('[data-ci-save]')?.dataset.ciSave;
  if (t.closest('[data-ci-close]')) close();
  else if (t.closest('[data-ci-files]')) {
    close();
    openFiles();
  } else if (t.closest('[data-ci-reset]')) post({ type: 'contextReset' });
  else if (t.closest('[data-ci-cancel]')) {
    editing = null;
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
