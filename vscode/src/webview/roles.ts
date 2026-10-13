/**
 * "Who does what" in settings: drag models from the palette onto roles. A model can serve
 * several roles (dragging from the palette copies it), and a role can hold many models, routed by
 * the strategy chosen for it: priority (in order), random, least busy (spreads parallel helpers
 * over providers) or smartest first. Drag within or between roles to reorder or move; "+ Add" and
 * × do the same by click. Saved to roles.json by omnexx.
 */
import * as modelPicker from './modelPicker.js';
import { badge, type ModelItem } from './modelPicker.js';
import { escapeHtml } from './render.js';

type Post = (msg: Record<string, unknown>) => void;
type Role = 'chat' | 'planner' | 'worker' | 'cheap' | 'helpers';
type Strategy = 'priority' | 'random' | 'least-busy' | 'smart';

interface Roles {
  models: Partial<Record<Role, string[]>>;
  strategies: Partial<Record<Role, Strategy>>;
  spreadHelpers: boolean;
}

const ROLES: { id: Role; name: string; what: string }[] = [
  { id: 'chat', name: 'Chat', what: 'talks with you in this panel' },
  { id: 'planner', name: 'Planner', what: 'plans runs, takes over stuck tasks' },
  { id: 'worker', name: 'Worker', what: 'writes the code in long runs' },
  { id: 'cheap', name: 'Quick jobs', what: 'summaries, routing, small steps' },
  { id: 'helpers', name: 'Helpers', what: 'subagents working in parallel' },
];

const STRATEGIES: { id: Strategy; label: string; title: string }[] = [
  {
    id: 'priority',
    label: 'Priority',
    title: 'Top model first; the rest take over on failure or empty quota',
  },
  { id: 'random', label: 'Random', title: 'Shuffle each time, spreading the load evenly' },
  {
    id: 'least-busy',
    label: 'Least busy',
    title: 'Start on the provider with the fewest helpers running',
  },
  { id: 'smart', label: 'Smartest', title: 'Most capable model first' },
];

const ROLE_IDS = new Set<string>(ROLES.map((r) => r.id));
const MAX_PER_ROLE = 20;

let roles: Roles = { models: {}, strategies: {}, spreadHelpers: true };
let exhausted: Record<string, number> = {};
let palette: ModelItem[] = [];
let post: Post | undefined;
/** What is being dragged: a ref, and the role it came from (none when from the palette). */
let dragging: { ref: string; from?: Role } | undefined;

function defaultStrategy(role: Role): Strategy {
  return role === 'helpers' && roles.spreadHelpers ? 'least-busy' : 'priority';
}

function chip(ref: string, opts: { role?: Role; index?: number }): string {
  const [provider = '', ...rest] = ref.split(':');
  const out = exhausted[ref] !== undefined;
  const where = opts.role
    ? ` data-role="${opts.role}" data-index="${String(opts.index ?? 0)}"`
    : '';
  const num = opts.role ? `<span class="rc-n">${String((opts.index ?? 0) + 1)}</span>` : '';
  const remove = opts.role
    ? `<button class="rc-x" data-role-remove="${opts.role}" data-ref="${escapeHtml(ref)}" aria-label="Remove ${escapeHtml(ref)}">×</button>`
    : '';
  return `<span class="rchip${out ? ' out' : ''}${opts.role ? '' : ' pal'}" draggable="true" data-ref="${escapeHtml(ref)}"${where} title="${escapeHtml(ref)}${out ? ' (out of quota today)' : ''}">${badge(provider)}${num}<span class="rc-name">${escapeHtml(rest.join(':'))}</span>${out ? '<span class="rc-q" aria-label="out of quota">⏳</span>' : ''}${remove}</span>`;
}

function strategyHtml(role: Role): string {
  const current = roles.strategies[role] ?? defaultStrategy(role);
  return `<div class="strat" role="group" aria-label="${role} routing">${STRATEGIES.map(
    (s) =>
      `<button data-strategy="${s.id}" data-strategy-role="${role}" aria-pressed="${String(s.id === current)}" title="${s.title}">${s.label}</button>`,
  ).join('')}</div>`;
}

function roleHtml(r: (typeof ROLES)[number]): string {
  const list = roles.models[r.id] ?? [];
  const chips = list.map((ref, i) => chip(ref, { role: r.id, index: i })).join('');
  const empty = list.length
    ? ''
    : '<span class="rc-empty">Drop models here · uses your pool until then</span>';
  const routing = list.length > 1 || r.id === 'helpers' ? strategyHtml(r.id) : '';
  return `<div class="role" data-drop-role="${r.id}"><div class="role-head"><span class="role-name">${r.name}</span><span class="role-what">${r.what}</span><button class="rc-add" data-role-add="${r.id}" aria-label="Add a model to ${r.name}">+</button></div><div class="role-chips">${chips}${empty}</div>${routing}</div>`;
}

function paletteHtml(): string {
  if (!palette.length)
    return '<p class="hint">Connect a provider below; its models appear here to drag onto roles.</p>';
  const groups = new Map<string, ModelItem[]>();
  for (const m of palette) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups]
    .map(
      ([provider, items]) =>
        `<div class="pal-group"><span class="pal-name">${escapeHtml(provider)}</span><div class="pal-chips">${items.map((m) => chip(m.ref, {})).join('')}</div></div>`,
    )
    .join('');
}

export function html(): string {
  return `<div class="palette" aria-label="Your models">${paletteHtml()}</div><div class="roles">${ROLES.map(roleHtml).join('')}</div><p class="hint">Drag a model onto a role (it can serve several). Order is priority; ⏳ means out of quota today. Applies to new chats and runs.</p>`;
}

function redraw(): void {
  const box = document.getElementById('roles-box');
  if (box) box.innerHTML = html();
}

function save(): void {
  post?.({ type: 'setRoles', roles });
  redraw();
}

function withList(role: Role, list: string[]): void {
  roles = { ...roles, models: { ...roles.models, [role]: list.slice(0, MAX_PER_ROLE) } };
}

/** Put `ref` into `role` at `at` (end when undefined); a move takes it out of `from` first. */
function place(ref: string, role: Role, at: number | undefined, from?: Role): void {
  if (from)
    withList(
      from,
      (roles.models[from] ?? []).filter((x) => x !== ref),
    );
  const list = (roles.models[role] ?? []).filter((x) => x !== ref);
  const i = at === undefined ? list.length : Math.min(at, list.length);
  withList(role, [...list.slice(0, i), ref, ...list.slice(i)]);
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
  exhausted = (m.exhausted as Record<string, number> | undefined) ?? {};
  redraw();
  return true;
}

export function request(p: Post): void {
  post = p;
  p({ type: 'roles' });
}

/** Clicks inside the roles box; true when handled. */
export function click(t: Element, p: Post): boolean {
  post = p;
  const add = t.closest<HTMLElement>('[data-role-add]');
  if (add) {
    const role = add.dataset.roleAdd as Role;
    modelPicker.open(add, p, (ref) => {
      place(ref, role, undefined);
    });
    return true;
  }
  const remove = t.closest<HTMLElement>('[data-role-remove]');
  if (remove) {
    const role = remove.dataset.roleRemove as Role;
    withList(
      role,
      (roles.models[role] ?? []).filter((x) => x !== remove.dataset.ref),
    );
    save();
    return true;
  }
  const strat = t.closest<HTMLElement>('[data-strategy]');
  if (strat?.dataset.strategyRole && ROLE_IDS.has(strat.dataset.strategyRole)) {
    const role = strat.dataset.strategyRole as Role;
    roles = {
      ...roles,
      strategies: { ...roles.strategies, [role]: strat.dataset.strategy as Strategy },
    };
    save();
    return true;
  }
  return false;
}

/** Drag and drop for the palette and the role slots (HTML5 drag events, delegated). */
export function wireDrag(root: HTMLElement): void {
  root.addEventListener('dragstart', (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.rchip') : null;
    if (!el?.dataset.ref) return;
    const from =
      el.dataset.role && ROLE_IDS.has(el.dataset.role) ? (el.dataset.role as Role) : undefined;
    dragging = { ref: el.dataset.ref, ...(from ? { from } : {}) };
    e.dataTransfer?.setData('text/plain', el.dataset.ref);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = from ? 'move' : 'copy';
    el.classList.add('dragging');
  });
  root.addEventListener('dragend', () => {
    dragging = undefined;
    for (const x of root.querySelectorAll('.dragging, .drop-over'))
      x.classList.remove('dragging', 'drop-over');
  });
  root.addEventListener('dragover', (e) => {
    const zone =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-drop-role]') : null;
    if (!zone || !dragging) return;
    e.preventDefault();
    for (const x of root.querySelectorAll('.drop-over'))
      if (x !== zone) x.classList.remove('drop-over');
    zone.classList.add('drop-over');
  });
  root.addEventListener('drop', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const zone = target?.closest<HTMLElement>('[data-drop-role]');
    if (!zone?.dataset.dropRole || !dragging || !ROLE_IDS.has(zone.dataset.dropRole)) return;
    e.preventDefault();
    const role = zone.dataset.dropRole as Role;
    // Dropped on a chip: insert before it; anywhere else in the role: at the end.
    const onChip = target?.closest<HTMLElement>('.rchip[data-role]');
    const at = onChip?.dataset.role === role ? Number(onChip.dataset.index) : undefined;
    place(dragging.ref, role, at, dragging.from);
    dragging = undefined;
  });
}
