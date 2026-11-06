/**
 * The `calibrated-local` backend: answers any System-1 request from the gate's feature model,
 * with zero network. Unknown (ad-hoc) questions get an honest maximum-entropy answer.
 */
import {
  completenessWeights,
  completionProb,
  destructiveProb,
  intentWeights,
  patchSignals,
  placeholderProb,
  triageWeights,
  type ContinuationState,
} from './features.js';
import { choiceAnswer, noulAnswer, scoreAnswer } from './normalize.js';
import type { SystemOneGate, SystemOneQuestion } from './types.js';

type Answer =
  ReturnType<typeof noulAnswer> | ReturnType<typeof choiceAnswer> | ReturnType<typeof scoreAnswer>;

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function continuationOf(state: Record<string, unknown>): ContinuationState {
  return {
    filesModified: Array.isArray(state.filesModified)
      ? state.filesModified.length
      : num(state.filesModified),
    testsPassed: state.testsPassed === true,
    testsFailed: state.testsFailed === true,
    redundantReadOnly: num(state.redundantReadOnly),
    assistantSummary: str(state.assistantSummary),
    pendingCalls: num(state.pendingCalls),
  };
}

function noulFor(gate: SystemOneGate, state: Record<string, unknown>): number {
  switch (gate) {
    case 'guardrail':
      return destructiveProb(
        str(state.command),
        str(state.cwd),
        str(state.repoRoot),
        state.allowOutsideRepo === true,
      );
    case 'continuation':
      return completionProb(continuationOf(state));
    case 'patch':
      return placeholderProb(patchSignals(str(state.oldText), str(state.newText)));
    default:
      return 0.5;
  }
}

function choiceWeights(
  gate: SystemOneGate,
  key: string,
  state: Record<string, unknown>,
): Record<string, number> {
  if (gate === 'intent') return intentWeights(str(state.prompt));
  if (gate === 'triage') {
    const chunks = state.chunks;
    const idx = Number(key.replace(/^\D+/, ''));
    const chunk = Array.isArray(chunks) && typeof chunks[idx] === 'string' ? chunks[idx] : '';
    return triageWeights(chunk);
  }
  return {};
}

export function localAnswers(
  gate: SystemOneGate,
  state: Record<string, unknown>,
  questions: Record<string, SystemOneQuestion>,
): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') out[key] = noulAnswer(noulFor(gate, state));
    else if (q.type === 'choice')
      out[key] = choiceAnswer(Object.keys(q.criteria), choiceWeights(gate, key, state));
    else
      out[key] = scoreAnswer(
        q.criteria,
        gate === 'patch'
          ? completenessWeights(patchSignals(str(state.oldText), str(state.newText)))
          : {},
        gate === 'patch' ? undefined : (q.criteria.length - 1) / 2,
      );
  }
  return out;
}
