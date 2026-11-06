/**
 * System-1 decision-model wire types (`POST /v1/systemone`): the `noul`, `choice` and `score`
 * primitives Jev (TypeSafe), Kev, Clef and other System-1 endpoints share. Builders keep the
 * answer type tied to the question, so `answers[key]` is typed without casts.
 */

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion<K extends string = string> {
  type: 'choice';
  instructions: string;
  criteria: Record<K, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** 2–10 ordered rubric levels; the answer's `score` is an index into them (0..N-1). */
  criteria: readonly string[];
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** Probability the statement is true, in [0, 1]. */
  noul: number;
  /** Alias of `noul`. */
  prob: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: 'choice';
  choice: K;
  /** Normalized to sum to 1. */
  probabilities: Record<K, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Index into the rubric (0..N-1). */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type AnswerOf<Q> =
  Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : Q extends NoulQuestion
        ? NoulAnswer
        : never;

export type Answers<Q extends Record<string, SystemOneQuestion>> = {
  [P in keyof Q]: AnswerOf<Q[P]>;
};

export type SystemOneBackendKind = 'jev-http' | 'ollama-s1' | 'calibrated-local';

/** Which harness gate asks: lets the calibrated local scorer pick its feature model. */
export type SystemOneGate = 'guardrail' | 'continuation' | 'triage' | 'intent' | 'patch' | 'adhoc';

export interface SystemOneRequest<Q extends Record<string, SystemOneQuestion>> {
  state: Record<string, unknown>;
  questions: Q;
  model?: string;
  gate?: SystemOneGate;
}

export interface SystemOneUsage {
  inputTokens: number;
  usd: number;
}

export interface SystemOneResponse<Q extends Record<string, SystemOneQuestion>> {
  model: string;
  answers: Answers<Q>;
  usage: SystemOneUsage;
  backend: SystemOneBackendKind;
  latencyMs: number;
  cached: boolean;
}

export function noul(
  instructions: string,
  criteria?: { true?: string; false?: string } | null,
): NoulQuestion {
  return { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
}

export function choice<K extends string>(
  instructions: string,
  criteria: Record<K, string | null>,
): ChoiceQuestion<K> {
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: string, criteria: readonly string[]): ScoreQuestion {
  if (criteria.length < 2 || criteria.length > 10)
    throw new RangeError('score needs 2 to 10 rubric levels');
  return { type: 'score', instructions, criteria: [...criteria] };
}

/** A 1..5 rubric: answer `score + 1` is the 1..5 value. */
export function score1to5(
  instructions: string,
  levels: readonly [string, string, string, string, string],
): ScoreQuestion {
  return score(instructions, levels);
}

/** The 1-based value of a score answer (index 0 → 1). */
export const scoreValue = (a: ScoreAnswer): number => a.score + 1;
