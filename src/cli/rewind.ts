/**
 * Multi-phase rewind: pick a prior turn, then choose what to restore. When file checkpointing is
 * on the restore prompt offers `both` | `conversation` | `code` | `cancel`; `code` rewinds files
 * only and leaves the conversation intact. The decision logic is pure and sync so it is
 * unit-testable without rendering the prompt.
 */

/** The exact restore choices offered when file checkpointing is on. */
export const RESTORE_CHOICES = ['both', 'conversation', 'code', 'cancel'] as const;
export type RestoreChoice = (typeof RESTORE_CHOICES)[number];

/** One selectable prior turn in the rewind pick-list. */
export interface RewindTurn {
  id: string;
  /** Short human label, e.g. "#12 · fixing CI". */
  label: string;
  /** True when this turn has a file checkpoint that can be restored. */
  checkpoint?: boolean;
}

/** Async diff summary for a turn, shown in the pick-list footer. */
export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** What a rewind should restore. */
export interface RestoreAction {
  /** Rewind the conversation/history to the selected turn. */
  conversation: boolean;
  /** Restore files from that turn's checkpoint. */
  files: boolean;
}

/**
 * Resolve what the user typed at the restore prompt.
 *
 * With checkpointing ON the choices are exactly `both` | `conversation` | `code` | `cancel`
 * (`code` restores files only and keeps the conversation). With checkpointing OFF we keep the
 * legacy Y/N confirm; without checkpoints files cannot be restored, so "yes" means the
 * conversation. Returns `undefined` for unrecognised input so the caller keeps prompting.
 */
export function parseRestoreChoice(
  input: string,
  checkpointing: boolean,
): RestoreAction | 'cancel' | undefined {
  const t = input.trim().toLowerCase();
  if (!checkpointing) {
    if (t === 'y' || t === 'yes') return { conversation: true, files: false };
    if (t === 'n' || t === 'no') return 'cancel';
    return undefined;
  }
  switch (t) {
    case 'both':
      return { conversation: true, files: true };
    case 'conversation':
      return { conversation: true, files: false };
    case 'code':
      return { conversation: false, files: true };
    case 'cancel':
      return 'cancel';
    default:
      return undefined;
  }
}
