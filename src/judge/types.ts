import type { JudgeUse } from '../config/schema.js';

export type JudgeQuestion =
  | { id: string; type: 'choice'; prompt: string; options: string[] }
  | { id: string; type: 'noul'; prompt: string }
  | { id: string; type: 'score'; prompt: string; levels: string[] };

export type JudgeAnswer =
  | {
      id: string;
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { id: string; type: 'noul'; probability: number }
  | {
      id: string;
      type: 'score';
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
    };

export type JudgeResult =
  | {
      status: 'answered';
      answers: JudgeAnswer[];
      judge: string;
      latencyMs: number;
      model: string;
      inputBytes: number;
      endpointHost: string;
    }
  | { status: 'abstain'; reason: string; judge: string };

/**
 * A judge answers typed questions about a compact state. It is advisory: callers must never let
 * an answer accept a failed cycle, reject a passing one, allow a denied command, or override a stop.
 */
export interface Judge {
  readonly kind: string;
  ask(use: JudgeUse, state: unknown, questions: readonly JudgeQuestion[]): Promise<JudgeResult>;
}

export const MAX_QUESTIONS = 64;
export const MAX_OPTIONS = 26;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PROMPT_TOKENS = 8_192;
export const MAX_STATE_BYTES = 16 * 1024;
/** Nimble's own estimate is ~3.5 chars per token; used only for the 8K prompt bound. */
export const JUDGE_CHARS_PER_TOKEN = 3.5;

export function validateQuestions(questions: readonly JudgeQuestion[]): string | undefined {
  if (questions.length < 1 || questions.length > MAX_QUESTIONS)
    return `need 1-${MAX_QUESTIONS} questions`;
  for (const q of questions) {
    const n = q.type === 'choice' ? q.options.length : q.type === 'score' ? q.levels.length : 2;
    if (n < 2 || n > MAX_OPTIONS) return `${q.id}: needs 2-${MAX_OPTIONS} options`;
  }
  return undefined;
}

/** Check an answer set matches what was asked: same ids, choices from the option set, probabilities in [0,1]. */
export function answersMatch(
  questions: readonly JudgeQuestion[],
  answers: readonly JudgeAnswer[],
): string | undefined {
  const inRange = (p: number): boolean => Number.isFinite(p) && p >= 0 && p <= 1;
  for (const q of questions) {
    const a = answers.find((x) => x.id === q.id);
    if (!a) return `missing answer for ${q.id}`;
    if (a.type !== q.type) return `${q.id}: expected ${q.type}, got ${a.type}`;
    if (q.type === 'choice' && a.type === 'choice') {
      if (!q.options.includes(a.choice)) return `${q.id}: "${a.choice}" is not one of the options`;
      if (!inRange(a.confidence) || !Object.values(a.probabilities).every(inRange))
        return `${q.id}: probability out of range`;
    }
    if (q.type === 'noul' && a.type === 'noul' && !inRange(a.probability))
      return `${q.id}: probability out of range`;
    if (
      q.type === 'score' &&
      a.type === 'score' &&
      !(a.score >= 0 && a.score <= q.levels.length - 1)
    ) {
      return `${q.id}: score out of range`;
    }
  }
  return undefined;
}
