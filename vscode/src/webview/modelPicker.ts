/**
 * The model picker: a searchable popover listing every model from the connected providers,
 * grouped by provider, with the current one checked. Opens from the header chip and from the
 * settings page; arrow keys, Enter and Escape work.
 */
import { badge, modelDetailTags, type ModelItem } from './badge.js';
import { escapeHtml } from './render.js';

export { badge, modelDetailTags, providerHue, type ModelItem } from './badge.js';

type Post = (msg: Record<string, unknown>) => void;

let items: ModelItem[] = [];
let unreachable: string[] = [];
let current: string | null = null;
let query = '';
let cursor = 0;
let loading = false;
let anchor: HTMLElement | undefined;
let post: Post | undefined;
/** Provider groups the person folded shut; searching opens them all again. */
let collapsed = new Set<string>();
/** When set, picking a model hands it here (e.g. to add it to a role) instead of switching chat. */
let onPick: ((ref: string) => void) | undefined;

function root(): HTMLElement {
  const el = document.getElementById('model-picker');
  if (!el) throw new Error('missing #model-picker');
  return el;
}

function matches(): ModelItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((m) => {
    const haystack = `${m.provider} ${m.ref}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

function isGroupCollapsed(provider: string): boolean {
  return !query && collapsed.has(provider);
}

function allItems(): ModelItem[] {
  const list = matches();
  const custom = customModelItem();
  return custom ? [...list, custom] : list;
}

function visibleItems(): ModelItem[] {
  return allItems().filter((m) => !isGroupCollapsed(m.provider));
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
  const all = allItems();
  const custom = customModelItem();
  const visible = all.filter((m) => !isGroupCollapsed(m.provider));
  const counts = new Map<string, number>();
  for (const m of all) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  const rowIndex = new Map<ModelItem, number>();
  visible.forEach((m, i) => rowIndex.set(m, i));
  cursor = Math.min(cursor, Math.max(0, visible.length - 1));
  let rows = '';
  let lastProvider = '';
  all.forEach((m) => {
    const folded = isGroupCollapsed(m.provider);
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      const count = counts.get(m.provider) ?? 0;
      rows += `<li class="mp-group" role="presentation"><button type="button" class="mp-group-head" data-mp-group="${escapeHtml(m.provider)}" aria-expanded="${String(!folded)}" title="${folded ? 'Expand' : 'Collapse'} ${escapeHtml(m.provider)}">${badge(m.provider)}<span class="mp-group-name">${escapeHtml(m.provider)}</span><span class="mp-count">${String(count)}</span><span class="mp-chev" aria-hidden="true">▾</span></button></li>`;
    }
    if (folded) return;
    const isCurrent = m.ref === current;
    const isCustom = m.ref === custom?.ref;
    const detail = modelDetailTags(m.model)
      .map(
        (tag) =>
          `<span class="mp-tag${tag === 'free' ? ' mp-tag-free' : ''}">${escapeHtml(tag)}</span>`,
      )
      .join('');
    const idx = rowIndex.get(m) ?? 0;
    rows += `<li class="mp-item${idx === cursor ? ' active' : ''}${isCurrent ? ' current' : ''}${isCustom ? ' mp-custom-entry' : ''}" role="option" aria-selected="${String(isCurrent)}" data-ref="${escapeHtml(m.ref)}" data-index="${String(idx)}"><span class="mp-name">${isCustom ? `Use model "<strong>${escapeHtml(m.ref)}</strong>"` : escapeHtml(m.model)}</span>${detail ? `<span class="mp-meta">${detail}</span>` : ''}${isCurrent ? '<span class="mp-check" aria-label="Current model">✓</span>' : ''}</li>`;
  });
  const empty = loading
    ? '<li class="mp-empty"><span class="spinner"></span> Loading models…</li>'
    : items.length
      ? '<li class="mp-empty">No model matches.</li>'
      : '<li class="mp-empty">No models yet. Add a provider in Settings or type a model ID directly.</li>';
  const note = unreachable.length
    ? `<div class="mp-note" role="status"><span class="mp-note-label">Couldn't reach:</span>${unreachable.map((p) => `<span class="mp-warn-pill">${escapeHtml(p)}</span>`).join('')}</div>`
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
  collapsed = new Set<string>();
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
    const all = visibleItems();
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
    const group = t?.closest<HTMLElement>('[data-mp-group]')?.dataset.mpGroup;
    if (group) {
      if (!query) {
        if (collapsed.has(group)) collapsed.delete(group);
        else collapsed.add(group);
        draw();
      }
      return;
    }
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
