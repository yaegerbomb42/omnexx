import type { CycleSummary } from '../agent/compaction.js';
import { renderWorkingState } from '../agent/working-state.js';

/**
 * The cheap model's instructions for a fold: the previous working state plus only the turns
 * since it, so it extends the state instead of summarizing a summary. Omnexx merges the answer
 * with the previous state itself, so the model reports only what these turns add or change.
 */
export function foldPrompt(
  task: { id: string; title: string },
  transcript: string,
  prior: CycleSummary | undefined,
): string {
  const previous = prior
    ? `\n\nThe working state before these turns (already kept; report only what the turns below add or change):\n${renderWorkingState(prior)}`
    : '';
  return `Fold this part of a coding agent's work on task ${task.id} ("${task.title}") into its working state so it can continue without the transcript. One line per item. done: steps finished. decisions: choices made and why. failed: approaches that did not work (don't repeat them). keyFiles: "path — what matters about it now" (not its contents). Drop chatter, repeated reads and dead ends already covered by "failed". Be concrete: file paths, commands, exact error text. Reply only by calling the answer tool.${previous}\n\n# Turns since\n${transcript}`;
}
