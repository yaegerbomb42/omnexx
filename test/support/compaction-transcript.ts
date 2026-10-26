import type { Message } from '../../src/providers/types.js';

/**
 * Fixture for the pre-limit staged compaction acceptance test.
 * Builds a transcript whose raw token estimate is `multiplier × budget` by appending
 * assistant/user turns with configurable result size. Tool commands are unique per turn
 * so no superseded-pruning can shrink it; tool results are kept intact by setting a
 * high `keepToolResults` in the test settings.
 */

/** First user message used by the fixture. */
export const firstMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Work on M1.T01' }],
};

/** Estimate of tokens for a message array using the same conservative 3 chars/token rule. */
function estimateMessages(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 3);
}

/**
 * Build `turns` assistant/tool-result pairs. Each result is padded to roughly
 * `resultChars` characters. Returns the messages and the computed token estimate.
 */
export function buildTranscript(
  turns: number,
  resultChars: number,
): { messages: Message[]; tokens: number } {
  const out: Message[] = [firstMessage];
  const pad = 'x'.repeat(resultChars);
  for (let i = 0; i < turns; i++) {
    out.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: `step ${i}` } }],
    });
    out.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `t${i}`, content: `${i}:${pad}\n` }],
    });
  }
  return { messages: out, tokens: estimateMessages(out) };
}

/**
 * Build a transcript whose total token estimate is `targetTokens × multiplier`.
 * Returns the messages and metadata useful for the acceptance assertion.
 */
export function buildOversizedTranscript(
  targetTokens: number,
  multiplier: number,
): { messages: Message[]; rawTokens: number; targetTokens: number } {
  // Each assistant + tool-result pair contributes roughly (resultChars / 3) tokens after JSON overhead.
  // Solve for resultChars to get the desired total.
  const desiredTotal = Math.ceil(targetTokens * multiplier);
  const resultChars = Math.ceil((desiredTotal * 3) / 12); // heuristic: 12 pairs cover overhead
  const { messages, tokens } = buildTranscript(12, resultChars);
  return { messages, rawTokens: tokens, targetTokens };
}
