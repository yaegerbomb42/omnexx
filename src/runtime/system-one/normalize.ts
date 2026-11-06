/** Shape any backend's raw answer into the exact typed System-1 answer. */
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer, SystemOneQuestion } from './types.js';

export const clamp01 = (x: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;

const num = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;

const obj = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

export function noulAnswer(p: number): NoulAnswer {
  const v = clamp01(p);
  return { type: 'noul', noul: v, prob: v };
}

/** Normalize weights over `keys` (missing or negative weights count as 0; all-zero → uniform). */
export function normalizeWeights<K extends string>(
  keys: readonly K[],
  weights: Partial<Record<string, number>>,
): Record<K, number> {
  const raw = keys.map((k) => Math.max(0, weights[k] ?? 0));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = {} as Record<K, number>;
  keys.forEach((k, i) => {
    out[k] = total > 0 ? (raw[i] ?? 0) / total : 1 / keys.length;
  });
  return out;
}

export function choiceAnswer<K extends string>(
  keys: readonly K[],
  weights: Partial<Record<string, number>>,
): ChoiceAnswer<K> {
  const probabilities = normalizeWeights(keys, weights);
  let best = keys[0] as K;
  for (const k of keys) if (probabilities[k] > probabilities[best]) best = k;
  return { type: 'choice', choice: best, probabilities, confidence: probabilities[best] };
}

export function scoreAnswer(
  criteria: readonly string[],
  weights: Partial<Record<string, number>>,
  picked?: number,
): ScoreAnswer {
  const keys = criteria.map((_, i) => String(i));
  const probabilities = normalizeWeights(keys, weights);
  const legend: Record<string, string> = {};
  criteria.forEach((c, i) => {
    legend[String(i)] = c;
  });
  let best = 0;
  keys.forEach((k, i) => {
    if ((probabilities[k] ?? 0) > (probabilities[String(best)] ?? 0)) best = i;
  });
  const anyWeight = keys.some((k) => (weights[k] ?? 0) > 0);
  const s =
    !anyWeight && picked !== undefined
      ? Math.min(criteria.length - 1, Math.max(0, Math.round(picked)))
      : best;
  return {
    type: 'score',
    score: s,
    legend,
    probabilities,
    confidence: anyWeight ? (probabilities[String(s)] ?? 0) : 1,
  };
}

const noulOf = (r: Record<string, unknown>): NoulAnswer => {
  const p = num(r.noul) ?? num(r.prob) ?? num(r.probability);
  if (p !== undefined) return noulAnswer(p);
  if (typeof r.value === 'boolean') return noulAnswer(r.value ? 1 : 0);
  return noulAnswer(0.5);
};

/** Known numeric weights from an upstream `probabilities` map, for the given keys. */
function weightsOf(r: Record<string, unknown>, keys: readonly string[]): Record<string, number> {
  const probs = obj(r.probabilities);
  const weights: Record<string, number> = {};
  for (const k of keys) {
    const w = num(probs[k]);
    if (w !== undefined) weights[k] = w;
  }
  return weights;
}

/** One upstream answer (any of the wire spellings) → the typed answer for `q`. */
export function normalizeAnswer(
  q: SystemOneQuestion,
  raw: unknown,
): NoulAnswer | ChoiceAnswer | ScoreAnswer {
  const r = obj(raw);
  if (q.type === 'noul') return noulOf(r);
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    const weights = weightsOf(r, keys);
    if (typeof r.choice === 'string' && !Object.keys(weights).length) weights[r.choice] = 1;
    return choiceAnswer(keys, weights);
  }
  const weights = weightsOf(
    r,
    q.criteria.map((_, i) => String(i)),
  );
  return scoreAnswer(q.criteria, weights, num(r.score));
}
