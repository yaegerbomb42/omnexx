/** The quiet "Saved ✓" in a settings section's header, in place of a chat-log message. */
import type { SectionId } from './settingsLayout.js';

const SAVED_FADE_MS = 1_800;

/** Show a fading "Saved ✓" in a section's header instead of a chat-log message. */
export function flashSaved(id: SectionId): void {
  const mark = document.querySelector<HTMLElement>(`[data-saved-for="${id}"]`);
  if (!mark) return;
  const turn = String(Number(mark.dataset.turn ?? '0') + 1);
  mark.dataset.turn = turn;
  mark.textContent = 'Saved ✓';
  mark.classList.add('shown');
  // Only the latest save clears the mark, so quick saves in a row keep it up.
  setTimeout(() => {
    if (mark.dataset.turn === turn) mark.classList.remove('shown');
  }, SAVED_FADE_MS);
}
