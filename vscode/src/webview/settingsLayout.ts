/**
 * The settings page's frame: a sticky nav of colored section chips, section headers with an icon,
 * a plain-English subtitle and a collapse toggle, friendly empty states, and the quiet "Saved ✓"
 * (savedMark.ts) that replaces chat-log confirmations. No DOM, so tests can import it.
 */
import { escapeHtml } from './render.js';

export type SectionId =
  | 'agent'
  | 'model'
  | 'models'
  | 'skills'
  | 'providers'
  | 'add'
  | 'approvals'
  | 'mcp'
  | 'browser'
  | 'advanced';

export interface SectionMeta {
  id: SectionId;
  title: string;
  /** The nav chip's short name. */
  chip: string;
  subtitle: string;
  /** Inner SVG (24×24 viewBox, stroked with currentColor). */
  icon: string;
}

export const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'agent',
    title: 'Agent',
    chip: 'Agent',
    subtitle: 'How hard omnexx works and how much it keeps in mind',
    icon: '<path d="M12 3l2.2 5.3L20 9l-4.4 3.8L17 19l-5-3-5 3 1.4-6.2L4 9l5.8-.7z"/>',
  },
  {
    id: 'model',
    title: 'Chat model',
    chip: 'Chat',
    subtitle: 'The model this chat talks to right now',
    icon: '<path d="M4 5h16v11H9l-5 4z"/>',
  },
  {
    id: 'models',
    title: 'Your models',
    chip: 'Models',
    subtitle: 'Which models answer, and in what order',
    icon: '<path d="M4 6h16M4 12h11M4 18h7"/>',
  },
  {
    id: 'skills',
    title: 'Skills',
    chip: 'Skills',
    subtitle: 'Know-how the agent loads only when a task needs it',
    icon: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 10h6M9 14h6"/>',
  },
  {
    id: 'providers',
    title: 'Providers',
    chip: 'Providers',
    subtitle: 'Accounts and servers omnexx can reach',
    icon: '<path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 18z"/>',
  },
  {
    id: 'add',
    title: 'Add a provider',
    chip: 'Add',
    subtitle: 'Connect a hosted account, a local server or any endpoint',
    icon: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
  },
  {
    id: 'approvals',
    title: 'Approvals',
    chip: 'Approvals',
    subtitle: 'What omnexx may do without asking you first',
    icon: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  },
  {
    id: 'mcp',
    title: 'MCP servers',
    chip: 'MCP',
    subtitle: 'Extra tools: a browser, your database, GitHub…',
    icon: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
  },
  {
    id: 'browser',
    title: 'Browser',
    chip: 'Browser',
    subtitle: 'The browser the agent drives for web tasks',
    icon: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>',
  },
  {
    id: 'advanced',
    title: 'Advanced',
    chip: 'More',
    subtitle: 'Config files, the engine, restart',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  },
];

/** Sections that start folded until the person opens them. */
export const FOLDED_BY_DEFAULT: readonly SectionId[] = ['add', 'browser', 'advanced'];

export function icon(svg: string): string {
  return `<svg class="sec-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;
}

const meta = (id: SectionId): SectionMeta => {
  const found = SECTIONS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown settings section "${id}"`);
  return found;
};

/** The sticky row of colored jump chips. */
export function navHtml(): string {
  return `<nav class="set-nav" aria-label="Settings sections">${SECTIONS.map(
    (s) =>
      `<button class="set-chip" data-sec="${s.id}" data-sec-jump="${s.id}" title="${escapeHtml(s.subtitle)}">${icon(s.icon)}<span>${escapeHtml(s.chip)}</span></button>`,
  ).join('')}</nav>`;
}

/** One section: a header that folds it (icon, title, subtitle, saved mark) over its body. */
export function sectionHtml(id: SectionId, body: string, folded: boolean, extraClass = ''): string {
  const s = meta(id);
  const open = String(!folded);
  return `<section class="set-section${extraClass ? ` ${extraClass}` : ''}${folded ? ' folded' : ''}" data-sec="${id}" id="sec-${id}">
<button class="sec-head" data-sec-toggle="${id}" aria-expanded="${open}" aria-controls="sec-body-${id}">${icon(s.icon)}<span class="sec-titles"><span class="sec-title">${escapeHtml(s.title)}</span><span class="sec-sub">${escapeHtml(s.subtitle)}</span></span><span class="sec-saved" data-saved-for="${id}" aria-live="polite"></span><span class="sec-chev" aria-hidden="true">▾</span></button>
<div class="sec-body" id="sec-body-${id}"${folded ? ' hidden' : ''}>${body}</div>
</section>`;
}

/** A friendly empty state: what is missing, why it matters, and the one thing to do next. */
export function emptyHtml(title: string, text: string, action?: string): string {
  return `<div class="empty"><div class="empty-title">${escapeHtml(title)}</div><p class="hint">${escapeHtml(text)}</p>${action ?? ''}</div>`;
}

/** Fold or unfold one section in a set of folded ids, without changing the original. */
export function toggled(folded: readonly SectionId[], id: SectionId, fold: boolean): SectionId[] {
  const rest = folded.filter((f) => f !== id);
  return fold ? [...rest, id] : rest;
}

export const isSectionId = (v: unknown): v is SectionId =>
  typeof v === 'string' && SECTIONS.some((s) => s.id === v);
