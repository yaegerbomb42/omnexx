/**
 * The model picker: a searchable popover listing every model from the connected providers,
 * grouped by provider, with the current one checked. Opens from the header chip and from the
 * settings page; arrow keys, Enter and Escape work.
 */
import { badge, type ModelItem } from './badge.js';
import { escapeHtml } from './render.js';

export { badge, providerHue, type ModelItem } from './badge.js';

type Post = (msg: Record<string, unknown>) => void;

let items: ModelItem[] = [];
let unreachable: string[] = [];
let current: string | null = null;
let query = '';
let cursor = 0;
let loading = false;
let anchor: HTMLElement | undefined;
let post: Post | undefined;
/** When set, picking a model hands it here (e.g. to add it to a role) instead of switching chat. */
let onPick: ((ref: string) => void) | undefined;

function root(): HTMLElement {
  const el = document.getElementById('model-picker');
  if (!el) throw new Error('missing #model-picker');
  return el;
}

function matches(): ModelItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((m) => words.every((w) => m.ref.toLowerCase().includes(w)));
}

function customModelItem(): ModelItem | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const list = matches();
  if (list.some((m) => m.ref.toLowerCase() === q.toLowerCase())) return undefined;
  const parts = q.split(':');
  const provider = parts.length > 1 && parts[0] ? parts[0] : 'custom';
  const model = parts.length > 1 ? parts.slice(1).join(':') : q;
  return { provider, model, ref: q };
}

function draw(): void {
  const list = matches();
  const custom = customModelItem();
  const all = custom ? [...list, custom] : list;
  cursor = Math.min(cursor, Math.max(0, all.length - 1));
  let rows = '';
  let lastProvider = '';
  all.forEach((m, i) => {
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      rows += `<li class="mp-group">${badge(m.provider)}<span>${escapeHtml(m.provider)}</span></li>`;
    }
    const isCurrent = m.ref === current;
    const isCustom = m.ref === custom?.ref;
    rows += `<li class="mp-item${i === cursor ? ' active' : ''}${isCurrent ? ' current' : ''}${isCustom ? ' mp-custom-entry' : ''}" role="option" aria-selected="${String(isCurrent)}" data-ref="${escapeHtml(m.ref)}" data-index="${String(i)}"><span class="mp-name">${isCustom ? `Use model "<strong>${escapeHtml(m.ref)}</strong>"` : escapeHtml(m.model)}</span>${isCurrent ? '<span class="mp-check">✓</span>' : ''}</li>`;
  });
  const empty = loading
    ? '<li class="mp-empty"><span class="spinner"></span> Loading models…</li>'
    : items.length
      ? '<li class="mp-empty">No model matches.</li>'
      : '<li class="mp-empty">No models yet. Add a provider in Settings or type a model ID directly.</li>';
  const note = unreachable.length
    ? `<div class="mp-note">Couldn't reach: ${escapeHtml(unreachable.join(', '))}</div>`
    : '';
  const list$ = root().querySelector('.mp-list');
  if (list$) list$.innerHTML = rows || empty;
  const note$ = root().querySelector('.mp-foot');
  if (note$)
    note$.innerHTML = `${note}<button class="ghost small" data-mp-settings>Add a provider…</button>`;
  root().querySelector('.mp-item.active')?.scrollIntoView({ block: 'nearest' });
}

function place(): void {
  const el = root();
  const r = anchor?.getBoundingClientRect();
  el.style.top = `${String(Math.round((r?.bottom ?? 40) + 6))}px`;
}

export function isOpen(): boolean {
  return !root().hidden;
}

export function open(from: HTMLElement, p: Post, pick?: (ref: string) => void): void {
  anchor = from;
  post = p;
  onPick = pick;
  query = '';
  cursor = Math.max(
    0,
    matches().findIndex((m) => m.ref === current),
  );
  loading = items.length === 0;
  const el = root();
  el.hidden = false;
  el.innerHTML =
    '<div class="mp-search"><input id="mp-input" type="text" placeholder="Search models…" aria-label="Search models" spellcheck="false" autocomplete="off"></div><ul class="mp-list" role="listbox"></ul><div class="mp-foot"></div>';
  place();
  draw();
  document.getElementById('mp-input')?.focus();
  p({ type: 'models' });
}

export function close(): void {
  root().hidden = true;
  anchor?.focus();
}

function choose(ref: string): void {
  if (onPick) onPick(ref);
  else {
    current = ref;
    post?.({ type: 'model', ref });
  }
  close();
}

export function setModels(list: ModelItem[], down: string[], now: string | null): void {
  items = list;
  unreachable = down;
  if (now) current = now;
  // The list just arrived: start on the model in use unless the person is already searching.
  if (loading && !query)
    cursor = Math.max(
      0,
      matches().findIndex((m) => m.ref === current),
    );
  loading = false;
  if (isOpen()) draw();
}

export function setCurrent(ref: string | null): void {
  current = ref;
}

export function wire(openSettings: () => void): void {
  const el = root();
  el.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement) {
      query = e.target.value;
      cursor = 0;
      draw();
    }
  });
  el.addEventListener('keydown', (e) => {
    const list = matches();
    const custom = customModelItem();
    const all = custom ? [...list, custom] : list;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % Math.max(1, all.length);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = all[cursor];
      if (pick) choose(pick.ref);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const ref = t?.closest<HTMLElement>('[data-ref]')?.dataset.ref;
    if (ref) choose(ref);
    else if (t?.closest('[data-mp-settings]')) {
      close();
      openSettings();
    }
  });
  // A click anywhere else closes it.
  document.addEventListener('mousedown', (e) => {
    if (!isOpen()) return;
    const t = e.target instanceof Node ? e.target : null;
    if (t && (el.contains(t) || anchor?.contains(t))) return;
    close();
  });
}
