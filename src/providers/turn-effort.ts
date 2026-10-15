import { reasoningEffort, thinkingBudget, type ReasoningEffort } from '../core/agent-levels.js';
import type { CompletionRequest, Provider } from './types.js';

/**
 * Effort per turn ([agent] turn_effort, 1-10): every call through the wrapped provider carries it
 * unless the caller set its own. Each provider turns it into its knob with the helpers below.
 */
export function withTurnEffort(inner: Provider, level: number | undefined): Provider {
  if (level === undefined) return inner;
  return {
    name: inner.name,
    complete: (req) =>
      inner.complete(req.turnEffort === undefined ? { ...req, turnEffort: level } : req),
  };
}

/** Anthropic's floor for a thinking budget. */
const MIN_THINKING_BUDGET = 1_024;

/**
 * Anthropic `thinking` for a request: a budget below max_tokens, or nothing (level 1, a forced
 * tool choice, which thinking does not allow, or no room under the output cap).
 */
export function anthropicThinking(
  req: Pick<CompletionRequest, 'turnEffort' | 'maxTokens' | 'toolChoice'>,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (req.turnEffort === undefined || req.toolChoice?.type === 'tool') return undefined;
  const budget = Math.min(thinkingBudget(req.turnEffort), req.maxTokens - MIN_THINKING_BUDGET);
  return budget >= MIN_THINKING_BUDGET ? { type: 'enabled', budget_tokens: budget } : undefined;
}

/** OpenAI-style `reasoning_effort`, or nothing when no level is set. */
export function openaiReasoning(
  req: Pick<CompletionRequest, 'turnEffort'>,
): ReasoningEffort | undefined {
  return req.turnEffort === undefined ? undefined : reasoningEffort(req.turnEffort);
}

/** Smallest thinking budget Gemini accepts on models that cannot turn thinking off. */
const MIN_GEMINI_BUDGET = 128;

/** Gemini `thinkingConfig`, or nothing when no level is set. */
export function geminiThinking(
  req: Pick<CompletionRequest, 'turnEffort'>,
): { thinkingBudget: number } | undefined {
  if (req.turnEffort === undefined) return undefined;
  return { thinkingBudget: Math.max(MIN_GEMINI_BUDGET, thinkingBudget(req.turnEffort)) };
}
