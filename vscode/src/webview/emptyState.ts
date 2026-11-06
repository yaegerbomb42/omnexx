/**
 * A quiet placeholder rendered when a surface has nothing to show yet.
 * `emptyStateHtml` stays the shared one (settings uses it for an empty provider
 * list); the chat panel uses `chatEmptyStateHtml`, a warm onboarding layout
 * whose cards fill the composer via the panel's existing `[data-suggest]` click
 * handling — no new event flow.
 */
export const EMPTY_STATE_TEXT = 'no runs yet: /run <goal> starts one';

/** The empty-state markup, shared by chat and settings. */
export function emptyStateHtml(): string {
  return `<div class="empty">${EMPTY_STATE_TEXT}</div>`;
}

interface QuickStart {
  icon: string;
  title: string;
  hint: string;
  prompt: string;
}

const SVG_BOOK = `<svg class="empty-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
const SVG_FLASK = `<svg class="empty-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-4.5 8.5A2 2 0 0 0 7.2 20h9.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M8 15h8"/></svg>`;
const SVG_SEARCH = `<svg class="empty-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;

/** The welcome / empty-state cards: same prompts the welcome section offers. */
export const QUICK_STARTS: readonly QuickStart[] = [
  {
    icon: SVG_BOOK,
    title: 'Explain this codebase',
    hint: 'Structure, entry points, where to start reading',
    prompt: 'Explain how this project is structured and where to start reading.',
  },
  {
    icon: SVG_FLASK,
    title: 'Fix failing tests',
    hint: 'Run the suite and repair what breaks',
    prompt: 'Run the tests and fix whatever fails.',
  },
  {
    icon: SVG_SEARCH,
    title: 'Review recent changes',
    hint: 'Hunt likely bugs in your latest work',
    prompt: 'Find likely bugs in the code I changed recently and fix them.',
  },
];

/** Interactive quick-start cards; clicking one fills the composer (data-suggest). */
export function quickStartCards(): string {
  return `<div class="suggestions">${QUICK_STARTS.map(
    (s) =>
      `<button class="card suggestion-card" data-suggest="${s.prompt}" title="${s.hint}"><span class="suggestion-icon" aria-hidden="true">${s.icon}</span><span class="suggestion-title">${s.title}</span><span class="suggestion-hint">${s.hint}</span></button>`,
  ).join('')}</div>`;
}

/** The chat panel's empty state: a welcoming header plus quick-start cards. */
export function chatEmptyStateHtml(): string {
  return `<div class="empty empty-chat"><div class="empty-title">Welcome to omnexx</div><p class="empty-sub">Tell it a goal and it edits this workspace, runs your tests, and asks before anything outside the repo.</p>${quickStartCards()}<p class="empty-hint">or type <code>/run &lt;goal&gt;</code> to start a background run</p></div>`;
}
