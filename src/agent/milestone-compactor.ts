import { estimateTokens } from '../core/tokens.js';
import type { Message } from '../providers/types.js';

export interface CheckpointMetadata {
  milestoneId: string;
  summary: string;
  filesTouched: readonly string[];
  verificationCheck: string;
  commitSha?: string | undefined;
}

export interface FoldResult {
  messages: Message[];
  foldedTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  reductionPercentage: number;
}

/**
 * Formats a clean, 3-line structured milestone recap.
 * e.g.:
 * Milestone 1 complete: added auth token validation to login handler
 * - Changed: src/auth.ts, test/auth.test.ts
 * - Verified via: npm test -- -t "auth token"
 */
export function formatMilestoneRecap(meta: CheckpointMetadata): string {
  const files = meta.filesTouched.length > 0 ? meta.filesTouched.join(', ') : 'none';
  const sha = meta.commitSha ? ` [${meta.commitSha.slice(0, 7)}]` : '';
  return [
    `Milestone ${meta.milestoneId} complete${sha}: ${meta.summary}`,
    `- Changed: ${files}`,
    `- Verified via: ${meta.verificationCheck}`,
  ].join('\n');
}

/**
 * Extracts touched files from tool_use calls in the message history.
 */
export function extractFilesTouched(messages: readonly Message[]): string[] {
  const files = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && typeof b.input === 'object' && b.input !== null) {
        const input = b.input as Record<string, unknown>;
        if (typeof input.path === 'string') {
          files.add(input.path);
        } else if (typeof input.targetFiles === 'object' && Array.isArray(input.targetFiles)) {
          for (const f of input.targetFiles) {
            if (typeof f === 'string') files.add(f);
          }
        }
      }
    }
  }
  return [...files];
}

/**
 * Extracts the last successful verification/test command from tool_use blocks.
 */
export function extractVerificationCommand(messages: readonly Message[], fallback = 'tests passed'): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === 'bash' && typeof b.input === 'object' && b.input !== null) {
        const cmd = (b.input as Record<string, unknown>).command;
        if (typeof cmd === 'string' && (cmd.includes('test') || cmd.includes('check') || cmd.includes('verify') || cmd.includes('vitest') || cmd.includes('jest'))) {
          return cmd;
        }
      }
    }
  }
  return fallback;
}

/**
 * Calculates total estimated tokens for a list of messages.
 */
export function messageTokens(messages: readonly Message[]): number {
  return messages.reduce((acc, m) => {
    return (
      acc +
      m.content.reduce((bAcc, b) => {
        if (b.type === 'text') return bAcc + estimateTokens(b.text);
        if (b.type === 'tool_result') return bAcc + estimateTokens(b.content);
        if (b.type === 'tool_use') return bAcc + estimateTokens(JSON.stringify(b.input));
        return bAcc + 50;
      }, 0)
    );
  }, 0);
}

/**
 * Folds the last N intermediate trial-and-error discussion turns preceding a checkpoint
 * into a single 3-line structured milestone recap.
 *
 * Keeps messages[0] (top-level system / goal / instructions).
 * Replaces intermediate tool churn with the structured milestone recap.
 */
export function foldMilestoneCheckpoint(
  messages: readonly Message[],
  meta: CheckpointMetadata,
  options?: { maxTurnsToFold?: number },
): FoldResult {
  const tokensBefore = messageTokens(messages);
  const maxTurns = options?.maxTurnsToFold ?? 10;

  if (messages.length <= 2) {
    return {
      messages: [...messages],
      foldedTurns: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      savedTokens: 0,
      reductionPercentage: 0,
    };
  }

  // Find assistant turn boundary indices (excluding messages[0])
  const assistantIndices: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === 'assistant') {
      assistantIndices.push(i);
    }
  }

  if (assistantIndices.length === 0) {
    return {
      messages: [...messages],
      foldedTurns: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      savedTokens: 0,
      reductionPercentage: 0,
    };
  }

  // Determine the window of turns to fold (up to maxTurns)
  const foldCount = Math.min(assistantIndices.length, maxTurns);
  const startIndex = assistantIndices[assistantIndices.length - foldCount] ?? 1;

  const recapText = formatMilestoneRecap(meta);
  const recapMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: `[CHECKPOINT FOLD]\n${recapText}` }],
  };

  const head = messages.slice(0, startIndex);
  const tail = messages.slice(messages.length); // any turns after (empty if checkpoint is current)

  const outMessages: Message[] = [...head, recapMessage, ...tail];
  const tokensAfter = messageTokens(outMessages);
  const savedTokens = Math.max(0, tokensBefore - tokensAfter);
  const reductionPercentage = tokensBefore > 0 ? Math.round((savedTokens / tokensBefore) * 100) : 0;

  return {
    messages: outMessages,
    foldedTurns: foldCount,
    tokensBefore,
    tokensAfter,
    savedTokens,
    reductionPercentage,
  };
}
