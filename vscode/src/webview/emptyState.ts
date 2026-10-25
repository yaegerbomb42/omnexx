/**
 * A quiet placeholder rendered when a surface has nothing to show yet.
 */
export const EMPTY_STATE_TEXT = 'no runs yet: /run <goal> starts one';

/** The empty-state markup, shared by chat and settings. */
export function emptyStateHtml(): string {
  return `<div class="empty">${EMPTY_STATE_TEXT}</div>`;
}
