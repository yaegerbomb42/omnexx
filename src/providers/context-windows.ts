/**
 * Context windows (input tokens) of well-known model families, for when a model profile does
 * not set `context`. Only documented windows; an unknown model gets none and the context budget
 * is then used as set. Sources: Anthropic models overview (2026-10), Google Gemini model docs,
 * OpenAI GPT-4.1 / GPT-5 model pages.
 */

const M1 = 1_000_000;
const GEMINI_1M = 1_048_576;
const GPT41_1M = 1_047_576;
const GPT5 = 400_000;
const K200 = 200_000;

/** First match wins; patterns are tested against the lower-cased model reference. */
const KNOWN: readonly (readonly [RegExp, number])[] = [
  [/claude-haiku-4-5/, K200],
  [/claude-(fable|mythos)-5/, M1],
  [/claude-opus-(5|4-[678])/, M1],
  [/claude-sonnet-(5|4-6)/, M1],
  [/claude-haiku-5/, M1],
  [/gemini-(2\.[05]|3)[\w.-]*-(pro|flash)/, GEMINI_1M],
  [/gpt-4\.1/, GPT41_1M],
  [/gpt-5/, GPT5],
];

/** The documented window of the model `ref` names ("provider:model" or a bare id), if known. */
export function knownWindow(ref: string): number | undefined {
  const id = ref.toLowerCase();
  return KNOWN.find(([re]) => re.test(id))?.[1];
}
