/**
 * The ranked model list widget used in settings: pure list operations (tested without a DOM) and
 * the HTML for a list and its mode toggle. A list is identified by `listId`: "pool" for the one
 * list everything uses, or a role name for the advanced per-role lists.
 */
import { badge, type ModelItem } from './badge.js';
import { escapeHtml } from './render.js';

export type Mode = 'random' | 'priority' | 'fallback';

export const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: 'random',
    label: 'Random',
    hint: 'Picks any model in the list on each call, spreading load and quota.',
  },
  {
    id: 'priority',
    label: 'Rank priority',
    hint: 'Always tries #1 first on each call; if it errors, the next one takes that call.',
  },
  {
    id: 'fallback',
    label: 'Fallback on quota',
    hint: 'Sticks with #1 until it runs out of quota or is rate-limited, then #2, until #1 recovers.',
  },
];

export const MAX_LIST = 64;

/** Insert `ref` at `at` (end when undefined), moving it there if it is already in the list. */
export function placeRef(
  list: readonly string[],
  ref: string,
  at?: number,
  max = MAX_LIST,
): string[] {
  const rest = list.filter((x) => x !== ref);
  const i = at === undefined ? rest.length : Math.max(0, Math.min(at, rest.length));
  return [...rest.slice(0, i), ref, ...rest.slice(i)].slice(0, max);
}

export function removeRef(list: readonly string[], ref: string): string[] {
  return list.filter((x) => x !== ref);
}

/** Move the item at `from` up or down by `by` places (clamped to the list). */
export function shiftRef(list: readonly string[], from: number, by: number): string[] {
  const ref = list[from];
  if (ref === undefined) return [...list];
  return placeRef(list, ref, Math.max(0, from + by));
}

/** Palette models whose ref has every typed word. */
export function filterModels(items: readonly ModelItem[], query: string): ModelItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((m) => words.every((w) => m.ref.toLowerCase().includes(w)));
}

export function modeOf(value: unknown): Mode {
  return MODES.find((m) => m.id === value)?.id ?? 'fallback';
}

function chipHtml(listId: string, ref: string, i: number, out: boolean): string {
  const [provider = '', ...rest] = ref.split(':');
  const name = escapeHtml(ref);
  return `<li class="rchip${out ? ' out' : ''}" draggable="true" tabindex="0" data-ref="${name}" data-list="${listId}" data-index="${String(i)}" title="${name}${out ? ' (out of quota, skipped until it resets)' : ''}. Drag to reorder; Alt+↑↓ moves it."><span class="rc-n">${String(i + 1)}</span>${badge(provider)}<span class="rc-name">${escapeHtml(rest.join(':'))}</span>${out ? '<span class="rc-q" aria-label="out of quota">⏳</span>' : ''}<button class="rc-x" data-rank-remove="${listId}" data-ref="${name}" aria-label="Remove ${name}">×</button></li>`;
}

/** A ranked list: numbered chips, a drop zone, and an empty-state hint. */
export function listHtml(
  listId: string,
  list: readonly string[],
  exhausted: Readonly<Record<string, number>>,
  empty: string,
): string {
  const chips = list.map((ref, i) => chipHtml(listId, ref, i, exhausted[ref] !== undefined));
  const body = chips.length ? chips.join('') : `<li class="rc-empty">${escapeHtml(empty)}</li>`;
  return `<ol class="rank-list" data-drop-list="${listId}" aria-label="Ranked models">${body}</ol>`;
}

/** The segmented mode control with the chosen mode's one-line explanation under it. */
export function modeHtml(listId: string, mode: Mode): string {
  const buttons = MODES.map(
    (m) =>
      `<button data-rank-mode="${m.id}" data-list="${listId}" aria-pressed="${String(m.id === mode)}" title="${escapeHtml(m.hint)}">${m.label}</button>`,
  ).join('');
  const hint = MODES.find((m) => m.id === mode)?.hint ?? '';
  return `<div class="strat" role="group" aria-label="How the list is used">${buttons}</div><p class="mode-hint">${escapeHtml(hint)}</p>`;
}

/** Palette chips grouped by provider; clicking one adds it to the main list. */
export function paletteChipsHtml(items: readonly ModelItem[], inList: ReadonlySet<string>): string {
  if (!items.length) return '<p class="hint">No models match.</p>';
  const groups = new Map<string, ModelItem[]>();
  for (const m of items) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups]
    .map(
      ([provider, ms]) =>
        `<div class="pal-group"><span class="pal-name">${escapeHtml(provider)}</span><div class="pal-chips">${ms
          .map(
            (m) =>
              `<button class="rchip pal${inList.has(m.ref) ? ' added' : ''}" draggable="true" data-ref="${escapeHtml(m.ref)}" data-pal-add="${escapeHtml(m.ref)}" title="Add ${escapeHtml(m.ref)} to the list (or drag it in)">${badge(provider)}<span class="rc-name">${escapeHtml(m.model)}</span></button>`,
          )
          .join('')}</div></div>`,
    )
    .join('');
}
