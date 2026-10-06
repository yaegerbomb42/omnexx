import { createHash } from 'node:crypto';
import { estimateTokens } from '../tokens.js';

/** The four isolated context banks. */
export type BankType = 'conversation' | 'working' | 'episodic' | 'agenda';

/** A discretely indexed semantic block stored in a context bank. */
export interface ContextBlock {
  id: string;
  bankType: BankType;
  content: string;
  /** Epoch seconds. */
  timestamp: number;
  tokenCount: number;
  /** Latent embedding assigned by the arbiter on insert; undefined until scored. */
  embedding?: Float64Array;
  isPinned: boolean;
  /** Last salience score assigned by the arbiter, in [0, 1]. */
  salience: number;
}

let counter = 0;

export function createBlock(
  bankType: BankType,
  content: string,
  opts: { isPinned?: boolean; timestamp?: number } = {},
): ContextBlock {
  const timestamp = opts.timestamp ?? Date.now() / 1000;
  const id = createHash('sha1')
    .update(`${bankType}:${content}:${timestamp}:${counter++}`)
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    bankType,
    content,
    timestamp,
    tokenCount: estimateTokens(content),
    isPinned: opts.isPinned ?? false,
    salience: 0,
  };
}
