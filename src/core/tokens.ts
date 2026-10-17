/**
 * Conservative token estimate without a tokenizer dependency. Current Claude tokenizers produce
 * more tokens per character than older ones, so 3 chars/token overestimates for budgeting.
 * Per-model correction lives in {@link calibratedTokens}; this function stays uncalibrated.
 */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Smoothing for the per-model ratio EMA. A consistent bias is mostly adopted within ~15 turns. */
export const TOKEN_RATIO_ALPHA = 0.2;
/** One bad response cannot shrink the estimate below a quarter or grow it past 4×. */
export const TOKEN_RATIO_MIN = 0.25;
export const TOKEN_RATIO_MAX = 4;
/** Unknown models: today's char estimate, unchanged. */
export const DEFAULT_TOKEN_RATIO = 1;

/**
 * `tokens` scaled by a model's prompt ratio. A ratio of 1 (or anything non-finite) returns
 * `tokens` unchanged, so a model that has not been seen cannot move a fold or a budget check.
 */
export function applyTokenRatio(tokens: number, ratio: number = DEFAULT_TOKEN_RATIO): number {
  if (!(tokens > 0) || !Number.isFinite(tokens)) return 0;
  if (!(ratio > 0) || !Number.isFinite(ratio) || ratio === 1) return Math.ceil(tokens);
  const capped = Math.min(TOKEN_RATIO_MAX, Math.max(TOKEN_RATIO_MIN, ratio));
  return Math.ceil(capped * tokens);
}

/** {@link estimateTokens} scaled by `ratio` (default 1). */
export function calibratedTokens(text: string, ratio: number = DEFAULT_TOKEN_RATIO): number {
  return applyTokenRatio(estimateTokens(text), ratio);
}

/**
 * Next EMA of `actual / estimated` (prompt tokens the provider reported, over the uncalibrated
 * estimate of that same prompt). Undefined when the estimate is 0 or the provider omitted usage,
 * so those turns do not move the ratio.
 */
export function nextTokenRatio(
  current: number,
  estimated: number,
  actual: number,
): number | undefined {
  if (!(estimated > 0) || !Number.isFinite(estimated)) return undefined;
  if (!(actual > 0) || !Number.isFinite(actual)) return undefined;
  const prior = Number.isFinite(current) && current > 0 ? current : DEFAULT_TOKEN_RATIO;
  const sample = actual / estimated;
  if (!Number.isFinite(sample)) return undefined;
  const blended = prior * (1 - TOKEN_RATIO_ALPHA) + TOKEN_RATIO_ALPHA * sample;
  if (!Number.isFinite(blended)) return undefined;
  return Math.min(TOKEN_RATIO_MAX, Math.max(TOKEN_RATIO_MIN, blended));
}
