/**
 * "Your models" in settings: one ranked list every role uses (click a model in the palette or
 * drag it in, drag to reorder, × to remove), with a mode toggle for how the list is used
 * (random, rank priority, fallback on quota). An "Advanced" expander gives chat, planning, work
 * and quick jobs their own lists with the same widget. The main list is the /models pool
 * (models.json); per-role lists are roles.json. Saved by omnexx.
 */
import * as modelPicker from './modelPicker.js';
import type { ModelItem } from './modelPicker.js';
import {
  filterModels,
  listHtml,
  MAX_LIST,
  modeHtml,
  modeOf,
  paletteChipsHtml,
  placeRef,
  removeRef,
  shiftRef,
  type Mode,
} from './rankList.js';
import { escapeHtml } from './render.js';

type Post = (msg: Record<string, unknown>) => void;
type Role = 'chat' | 'planner' | 'worker' | 'cheap' | 'helpers';
type Strategy = Mode | 'least-busy' | 'smart';

interface Roles {
  models: Partial<Record<Role, string[]>>;
  strategies: Partial<Record<Role, Strategy>>;
  spreadHelpers: boolean;
}

interface Pool {
  ranked: string[];
  mode: Mode;
}

const ROLES: { id: Role; name: string; what: string }[] = [
  { id: 'chat', name: 'Chat', what: 'talks with you in this panel' },
  { id: 'planner', name: 'Planning', what: 'plans runs, takes over stuck tasks' },
  { id: 'worker', name: 'Work', what: 'writes the code in long runs' },
  { id: 'cheap', name: 'Quick jobs', what: 'summaries, routing, small steps' },
  { id: 'helpers', name: 'Helpers', what: 'parallel subagents (off unless turned on)' },
];

const ROLE_IDS = new Set<string>(ROLES.map((r) => r.id));
const MAX_PER_ROLE = 20;
const POOL = 'pool';

let pool: Pool = { ranked: [], mode: 'fallback' };
let roles: Roles = { models: {}, strategies: {}, spreadHelpers: true };
let exhausted: Record<string, number> = {};
let palette: ModelItem[] = [];
let query = '';
let advancedOpen: boolean | undefined;
let post: Post | undefined;
/** What is being dragged: a ref, and the list it came from (none when from the palette). */
let dragging: { ref: string; from?: string } | undefined;

const isList = (id: string | undefined): id is string =>
  id === POOL || (id !== undefined && ROLE_IDS.has(id));

function listOf(id: string): string[] {
  return id === POOL ? pool.ranked : (roles.models[id as Role] ?? []);
}

function withList(id: string, list: string[]): void {
  if (id === POOL) pool = { ...pool, ranked: list.slice(0, MAX_LIST) };
  else roles = { ...roles, models: { ...roles.models, [id]: list.slice(0, MAX_PER_ROLE) } };
}

function modeFor(id: string): Mode {
  if (id === POOL) return pool.mode;
  const s = roles.strategies[id as Role];
  return s === 'random' || s === 'priority' || s === 'fallback' ? s : pool.mode;
}

function roleHtml(r: (typeof ROLES)[number]): string {
  const list = roles.models[r.id] ?? [];
  const body = listHtml(r.id, list, exhausted, 'Empty: uses your main list. Drop models here.');
  const mode = list.length > 1 ? modeHtml(r.id, modeFor(r.id)) : '';
  return `<div class="role${r.id === 'helpers' ? ' minor' : ''}"><div class="role-head"><span class="role-name">${r.name}</span><span class="role-what">${r.what}</span><button class="rc-add" data-role-add="${r.id}" aria-label="Add a model to ${r.name}">+</button></div>${body}${mode}</div>`;
}

function paletteHtml(): string {
  if (!palette.length)
    return '<p class="hint">Connect a provider below; its models appear here to add to your list.</p>';
  return `<input id="pal-search" class="field" type="search" placeholder="Search models…" aria-label="Search models" value="${escapeHtml(query)}" spellcheck="false"><div id="pal-chips">${paletteChipsHtml(filterModels(palette, query), new Set(pool.ranked))}</div>`;
}

function advancedHtml(): string {
  const anySet = ROLES.some((r) => (roles.models[r.id] ?? []).length > 0);
  const open = advancedOpen ?? anySet;
  return `<details class="adv-roles"${open ? ' open' : ''}><summary>Advanced: different models per role (chat / planning / work / quick jobs)</summary><div class="roles">${ROLES.map(roleHtml).join('')}</div></details>`;
}

export function html(): string {
  return `<div class="palette" aria-label="Your models">${paletteHtml()}</div>
<div class="rank-main"><div class="role-head"><span class="role-name">Ranked list</span><span class="role-what">used for everything</span></div>${listHtml(POOL, pool.ranked, exhausted, 'Click or drag a model above to add it. #1 is tried first.')}${modeHtml(POOL, pool.mode)}</div>
${advancedHtml()}<p class="hint">⏳ means out of quota; it is skipped until its quota resets. Applies to new chats and runs.</p>`;
}

function redraw(): void {
  const box = document.getElementById('roles-box');
  if (!box) return;
  const hadFocus = document.activeElement?.id === 'pal-search';
  box.innerHTML = html();
  if (hadFocus) document.getElementById('pal-search')?.focus();
}

function save(): void {
  post?.({ type: 'setRoles', roles, pool });
  redraw();
}

/** Put `ref` into list `to` at `at` (end when undefined): a reorder within a list, a copy between. */
function place(ref: string, to: string, at: number | undefined): void {
  withList(to, placeRef(listOf(to), ref, at));
  save();
}

function setMode(id: string, mode: Mode): void {
  if (id === POOL) pool = { ...pool, mode };
  else roles = { ...roles, strategies: { ...roles.strategies, [id]: mode } };
  save();
}

export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type === 'models') {
    // Shared with the model picker; the palette just mirrors it.
    palette = (m.items as ModelItem[] | undefined) ?? [];
    redraw();
    return false;
  }
  if (m.type !== 'roles') return false;
  const r = m.roles as Partial<Roles> | undefined;
  if (r)
    roles = {
      models: r.models ?? {},
      strategies: r.strategies ?? {},
      spreadHelpers: r.spreadHelpers !== false,
    };
  const p = m.pool as Partial<Pool> | undefined;
  if (p) pool = { ranked: Array.isArray(p.ranked) ? p.ranked : [], mode: modeOf(p.mode) };
  exhausted = (m.exhausted as Record<string, number> | undefined) ?? {};
  redraw();
  return true;
}

export function request(p: Post): void {
  post = p;
  p({ type: 'roles' });
}

/** Clicks inside the models box; true when handled. */
export function click(t: Element, p: Post): boolean {
  post = p;
  const pal = t.closest<HTMLElement>('[data-pal-add]');
  if (pal?.dataset.palAdd) {
    place(pal.dataset.palAdd, POOL, undefined);
    return true;
  }
  const add = t.closest<HTMLElement>('[data-role-add]');
  if (add?.dataset.roleAdd && isList(add.dataset.roleAdd)) {
    const role = add.dataset.roleAdd;
    modelPicker.open(add, p, (ref) => {
      place(ref, role, undefined);
    });
    return true;
  }
  const remove = t.closest<HTMLElement>('[data-rank-remove]');
  if (remove?.dataset.ref && isList(remove.dataset.rankRemove)) {
    withList(
      remove.dataset.rankRemove,
      removeRef(listOf(remove.dataset.rankRemove), remove.dataset.ref),
    );
    save();
    return true;
  }
  const mode = t.closest<HTMLElement>('[data-rank-mode]');
  if (mode && isList(mode.dataset.list)) {
    setMode(mode.dataset.list, modeOf(mode.dataset.rankMode));
    return true;
  }
  const summary = t.closest('.adv-roles > summary');
  if (summary) {
    // Remember the expander across redraws (the browser toggles it after this click).
    advancedOpen = !(summary.parentElement as HTMLDetailsElement).open;
    return false;
  }
  return false;
}

function wireKeys(root: HTMLElement): void {
  root.addEventListener('input', (e) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.id !== 'pal-search') return;
    query = e.target.value;
    const chips = document.getElementById('pal-chips');
    if (chips)
      chips.innerHTML = paletteChipsHtml(filterModels(palette, query), new Set(pool.ranked));
  });
  // Alt+↑↓ on a focused chip moves it, so the list can be ranked without a mouse.
  root.addEventListener('keydown', (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('li.rchip') : null;
    if (!el || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const id = el.dataset.list;
    if (!isList(id)) return;
    e.preventDefault();
    const index = Number(el.dataset.index);
    const by = e.key === 'ArrowUp' ? -1 : 1;
    withList(id, shiftRef(listOf(id), index, by));
    save();
    document
      .querySelector<HTMLElement>(`li.rchip[data-list="${id}"][data-index="${String(index + by)}"]`)
      ?.focus();
  });
}

/** Drag and drop for the palette and the ranked lists (HTML5 drag events, delegated). */
export function wireDrag(root: HTMLElement): void {
  wireKeys(root);
  root.addEventListener('dragstart', (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.rchip') : null;
    if (!el?.dataset.ref) return;
    const from = isList(el.dataset.list) ? el.dataset.list : undefined;
    dragging = { ref: el.dataset.ref, ...(from ? { from } : {}) };
    e.dataTransfer?.setData('text/plain', el.dataset.ref);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    el.classList.add('dragging');
  });
  root.addEventListener('dragend', () => {
    dragging = undefined;
    for (const x of root.querySelectorAll('.dragging, .drop-over'))
      x.classList.remove('dragging', 'drop-over');
  });
  root.addEventListener('dragover', (e) => {
    const zone =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-drop-list]') : null;
    if (!zone || !dragging) return;
    e.preventDefault();
    for (const x of root.querySelectorAll('.drop-over'))
      if (x !== zone) x.classList.remove('drop-over');
    zone.classList.add('drop-over');
  });
  root.addEventListener('drop', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const zone = target?.closest<HTMLElement>('[data-drop-list]');
    const to = zone?.dataset.dropList;
    if (!dragging || !isList(to)) return;
    e.preventDefault();
    // Dropped on a chip: take its place; anywhere else in the list: at the end.
    const onChip = target?.closest<HTMLElement>('li.rchip');
    const at = onChip?.dataset.list === to ? Number(onChip.dataset.index) : undefined;
    place(dragging.ref, to, at);
    dragging = undefined;
  });
}
