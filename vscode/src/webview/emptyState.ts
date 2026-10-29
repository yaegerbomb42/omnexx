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

/** The welcome / empty-state cards: same prompts the welcome section offers. */
export const QUICK_STARTS: readonly QuickStart[] = [
  {
    icon: '📖',
    title: 'Explain this codebase',
    hint: 'Structure, entry points, where to start reading',
    prompt: 'Explain how this project is structured and where to start reading.',
  },
  {
    icon: '🧪',
    title: 'Fix failing tests',
    hint: 'Run the suite and repair what breaks',
    prompt: 'Run the tests and fix whatever fails.',
  },
  {
    icon: '🔍',
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
  return `<div class="empty empty-chat"><div class="empty-title">👋 Welcome to omnexx</div><p class="empty-sub">Tell it a goal and it edits this workspace, runs your tests, and asks before anything outside the repo.</p>${quickStartCards()}<p class="empty-hint">or type <code>/run &lt;goal&gt;</code> to start a background run</p></div>`;
}
