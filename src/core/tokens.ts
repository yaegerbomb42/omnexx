/**
 * Conservative token estimate without a tokenizer dependency. Current Claude tokenizers produce
 * more tokens per character than older ones, so 3 chars/token overestimates for budgeting.
 */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
