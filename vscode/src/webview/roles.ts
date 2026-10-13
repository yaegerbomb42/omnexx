/**
 * "Who does what" in settings: which models power each role, in priority order. The first model
 * is tried first; the rest take over when it fails or runs out of quota. Helpers can spread over
 * providers so parallel helpers use several quotas at once. Saved to roles.json by omnexx.
 */
import * as modelPicker from './modelPicker.js';
import { badge } from './modelPicker.js';
import { escapeHtml } from './render.js';

type Post = (msg: Record<string, unknown>) => void;
type Role = 'chat' | 'planner' | 'worker' | 'cheap' | 'helpers';

interface Roles {
  models: Partial<Record<Role, string[]>>;
  spreadHelpers: boolean;
}

const ROLES: { id: Role; name: string; what: string }[] = [
  { id: 'chat', name: 'Chat', what: 'talks with you in this panel (first model)' },
  { id: 'planner', name: 'Planner', what: 'plans long runs and takes over stuck tasks' },
  { id: 'worker', name: 'Worker', what: 'writes the code in long runs' },
  { id: 'cheap', name: 'Quick jobs', what: 'summaries, routing and small steps' },
  { id: 'helpers', name: 'Helpers', what: 'subagents that explore and review in parallel' },
];

let roles: Roles = { models: {}, spreadHelpers: true };
let exhausted: Record<string, number> = {};
let post: Post | undefined;

function chip(role: Role, ref: string, i: number): string {
  const [provider = '', ...rest] = ref.split(':');
  const out = exhausted[ref] !== undefined;
  return `<span class="rchip${out ? ' out' : ''}" title="${escapeHtml(ref)}${out ? ' (out of quota)' : ''}">${badge(provider)}<span class="rc-n">${String(i + 1)}</span><span class="rc-name">${escapeHtml(rest.join(':'))}</span>${out ? '<span class="rc-q">⏳</span>' : ''}<button class="rc-x" data-role-remove="${role}" data-ref="${escapeHtml(ref)}" aria-label="Remove ${escapeHtml(ref)}">×</button></span>`;
}

function rowHtml(r: (typeof ROLES)[number]): string {
  const list = roles.models[r.id] ?? [];
  const chips = list.length
    ? list.map((ref, i) => chip(r.id, ref, i)).join('')
    : '<span class="rc-empty">your model pool</span>';
  const spread =
    r.id === 'helpers'
      ? `<label class="switch"><input type="checkbox" data-spread ${roles.spreadHelpers ? 'checked' : ''}><span>Spread parallel helpers across providers</span></label>`
      : '';
  return `<div class="role"><div class="role-head"><span class="role-name">${r.name}</span><span class="role-what">${r.what}</span></div><div class="role-chips">${chips}<button class="rc-add" data-role-add="${r.id}">+ Add</button></div>${spread}</div>`;
}

export function html(): string {
  return `<div class="roles">${ROLES.map(rowHtml).join('')}</div><p class="hint">Order is priority: the first model is tried first, the rest take over when it fails or runs out of quota (⏳). Applies to new chats and runs.</p>`;
}

function redraw(): void {
  const box = document.getElementById('roles-box');
  if (box) box.innerHTML = html();
}

function save(): void {
  post?.({ type: 'setRoles', roles });
  redraw();
}

export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'roles') return false;
  const r = m.roles as Roles | undefined;
  if (r) roles = { models: r.models, spreadHelpers: r.spreadHelpers };
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
      const list = roles.models[role] ?? [];
      if (!list.includes(ref))
        roles = { ...roles, models: { ...roles.models, [role]: [...list, ref] } };
      save();
    });
    return true;
  }
  const remove = t.closest<HTMLElement>('[data-role-remove]');
  if (remove) {
    const role = remove.dataset.roleRemove as Role;
    const ref = remove.dataset.ref ?? '';
    roles = {
      ...roles,
      models: { ...roles.models, [role]: (roles.models[role] ?? []).filter((x) => x !== ref) },
    };
    save();
    return true;
  }
  return false;
}

export function change(t: Element): boolean {
  if (!(t instanceof HTMLInputElement) || !t.hasAttribute('data-spread')) return false;
  roles = { ...roles, spreadHelpers: t.checked };
  save();
  return true;
}
