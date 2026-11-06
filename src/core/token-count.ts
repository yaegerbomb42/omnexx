import { CHARS_PER_TOKEN, TOKEN_RATIO_ALPHA, TOKEN_RATIO_MAX, TOKEN_RATIO_MIN } from './tokens.js';
import type { ContentBlock, Message } from '../providers/types.js';

export interface TokenEstimate {
  tokens: number;
  chars: number;
  version: number;
}

/**
 * Deterministically serialize any object or value with sorted keys.
 * SonarCloud typescript:S2871 compliance: explicit (a, b) => a.localeCompare(b).
 */
export function deterministicStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => deterministicStringify(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}'
  );
}

/**
 * Incremental, memoized token accounting for message histories.
 * Uses a WeakMap on ContentBlock references so unchanged blocks cost O(1) across turns.
 */
export class TokenCounter {
  private readonly blockCache = new WeakMap<ContentBlock, TokenEstimate>();
  private currentRatio = 1.0;
  private consecutiveHighRatioCount = 0;
  private safetyMarginRatio = 1.0;

  constructor(initialRatio = 1.0) {
    if (Number.isFinite(initialRatio) && initialRatio > 0) {
      this.currentRatio = initialRatio;
    }
  }

  /**
   * Fast estimate of string characters to tokens with punctuation and whitespace weight adjustments.
   */
  public estimateString(text: string): number {
    if (text.length === 0) return 0;
    const len = text.length;
    let puncOrNewline = 0;
    const sampleLimit = Math.min(len, 2048);
    for (let i = 0; i < sampleLimit; i++) {
      const code = text.charCodeAt(i);
      if (code === 10 || code === 13 || (code >= 33 && code <= 47) || (code >= 58 && code <= 64)) {
        puncOrNewline++;
      }
    }
    const sampleFraction = puncOrNewline / sampleLimit;
    const effectiveCharsPerToken = Math.max(2.4, CHARS_PER_TOKEN - sampleFraction * 0.6);
    return Math.ceil(len / effectiveCharsPerToken);
  }

  /**
   * Get or compute token estimate for a single ContentBlock.
   * Cached in WeakMap.
   */
  public blockTokens(block: ContentBlock): number {
    const cached = this.blockCache.get(block);
    if (cached !== undefined) {
      return this.calibrate(cached.tokens);
    }

    let calculatedChars: number;
    let calculatedTokens: number;

    switch (block.type) {
      case 'text': {
        calculatedChars = block.text.length;
        calculatedTokens = this.estimateString(block.text);
        break;
      }
      case 'tool_result': {
        calculatedChars = block.content.length + block.toolUseId.length + 16;
        calculatedTokens = this.estimateString(block.content) + 6;
        break;
      }
      case 'tool_use': {
        const inputStr = deterministicStringify(block.input);
        calculatedChars = block.name.length + block.id.length + inputStr.length + 16;
        calculatedTokens = this.estimateString(inputStr) + 8;
        break;
      }
      case 'image': {
        calculatedChars = 100;
        calculatedTokens = 1500;
        break;
      }
      case 'opaque': {
        const repr =
          typeof block.block === 'string' ? block.block : deterministicStringify(block.block);
        calculatedChars = repr.length;
        calculatedTokens = this.estimateString(repr) + 10;
        break;
      }
      default: {
        const str = deterministicStringify(block);
        calculatedChars = str.length;
        calculatedTokens = this.estimateString(str) + 4;
        break;
      }
    }

    this.blockCache.set(block, { tokens: calculatedTokens, chars: calculatedChars, version: 1 });
    return this.calibrate(calculatedTokens);
  }

  /**
   * Raw (uncalibrated) block tokens, useful for calibration comparison.
   */
  public rawBlockTokens(block: ContentBlock): number {
    const cached = this.blockCache.get(block);
    if (cached !== undefined) return cached.tokens;
    this.blockTokens(block);
    return this.blockCache.get(block)?.tokens ?? 0;
  }

  /**
   * Total tokens in a message.
   */
  public messageTokens(message: Message): number {
    let sum = 4; // role and envelope overhead
    for (const block of message.content) {
      sum += this.blockTokens(block);
    }
    return sum;
  }

  /**
   * Sync and estimate total prompt tokens for an array of messages in O(new blocks).
   */
  public sync(messages: readonly Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.messageTokens(msg);
    }
    return total;
  }

  /**
   * Compute prefix token sum array for an array of messages.
   */
  public prefixTokens(messages: readonly Message[]): number[] {
    const prefixes: number[] = [];
    let running = 0;
    for (const msg of messages) {
      running += this.messageTokens(msg);
      prefixes.push(running);
    }
    return prefixes;
  }

  /**
   * Calibrate token estimates using actual usage reported by the provider.
   */
  public observeUsage(estimatedTokens: number, actualPromptTokens: number): void {
    if (!(estimatedTokens > 0) || !(actualPromptTokens > 0)) return;
    if (!Number.isFinite(estimatedTokens) || !Number.isFinite(actualPromptTokens)) return;

    const ratioSample = actualPromptTokens / estimatedTokens;
    if (!Number.isFinite(ratioSample)) return;

    if (ratioSample > 1.3) {
      this.consecutiveHighRatioCount++;
      if (this.consecutiveHighRatioCount >= 3) {
        this.safetyMarginRatio = Math.min(1.5, this.safetyMarginRatio * 1.1);
      }
    } else {
      if (this.consecutiveHighRatioCount > 0) {
        this.consecutiveHighRatioCount--;
      }
      if (ratioSample < 1.1 && this.safetyMarginRatio > 1.0) {
        this.safetyMarginRatio = Math.max(1.0, this.safetyMarginRatio * 0.95);
      }
    }

    const blended = this.currentRatio * (1 - TOKEN_RATIO_ALPHA) + TOKEN_RATIO_ALPHA * ratioSample;
    this.currentRatio = Math.min(TOKEN_RATIO_MAX, Math.max(TOKEN_RATIO_MIN, blended));
  }

  public getCalibrationRatio(): number {
    return this.currentRatio * this.safetyMarginRatio;
  }

  public getSafetyMarginRatio(): number {
    return this.safetyMarginRatio;
  }

  private calibrate(rawTokens: number): number {
    const effective = this.currentRatio * this.safetyMarginRatio;
    return Math.ceil(rawTokens * effective);
  }
}
