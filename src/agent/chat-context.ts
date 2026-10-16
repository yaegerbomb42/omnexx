import type { Message } from '../providers/types.js';
import { enforceBudget } from './budget-guard.js';
import { clearOldToolResults, pruneSuperseded } from './compaction.js';
import { pruneRules } from './prune-rules.js';

/** The chat's context settings (a slice of `config.context`). */
export interface ChatContextSettings {
  keep_tool_results: number;
  compact_keep_turns: number;
  budget_tokens?: number | undefined;
}

/**
 * The chat's free, model-free trim between messages: superseded results (re-reads, stale reads
 * after an edit, failed edits, searches whose files were read), old narration, then old tool
 * results beyond the newest few. Pure.
 */
export function trimChatHistory(
  history: readonly Message[],
  settings: ChatContextSettings,
): Message[] {
  const superseded = pruneSuperseded(history).messages;
  const ruled = pruneRules(superseded, settings.compact_keep_turns).messages;
  return clearOldToolResults(ruled, settings.keep_tool_results).messages;
}

/** Never over the user's budget: digest the largest blocks when a summary wasn't enough. */
export function capChatHistory(
  history: readonly Message[],
  settings: ChatContextSettings,
): Message[] {
  return settings.budget_tokens === undefined
    ? [...history]
    : enforceBudget(history, settings.budget_tokens).messages;
}
