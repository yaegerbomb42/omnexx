import type { OmnexxConfig } from '../config/schema.js';
import type { FailOpenJudge } from './fail-open.js';
import { fitSummary, type AgentStateSummary } from './state-summary.js';
import { IMPLEMENTED_MOVES, nextMoveQuestion, NEXT_MOVES, type NextMove } from './uses.js';

export interface NextMoveDecision {
  rule: NextMove;
  final: NextMove;
  pick?: NextMove;
  probability?: number;
  override?: 'below_threshold' | 'not_allowed' | 'unavailable' | 'advise_mode' | 'abstained';
}

/**
 * Ask the judge for the next move at a cycle boundary. The rule decision always stands unless
 * mode = steer and the pick is confident, allowed by the rules right now, and implemented.
 */
export async function decideNextMove(
  judge: FailOpenJudge,
  cfg: OmnexxConfig['judge'],
  summary: AgentStateSummary,
  rule: NextMove,
  allowed: ReadonlySet<NextMove>,
): Promise<NextMoveDecision> {
  if (!judge.enabled('next_move')) return { rule, final: rule };
  const r = await judge.ask('next_move', fitSummary(summary), [nextMoveQuestion]);
  const a = r.status === 'answered' ? r.answers[0] : undefined;
  if (a?.type !== 'choice' || !(NEXT_MOVES as readonly string[]).includes(a.choice)) {
    return { rule, final: rule, override: 'abstained' };
  }
  const pick = a.choice as NextMove;
  const probability = a.probabilities[pick] ?? a.confidence;
  const base = { rule, pick, probability };
  if (cfg.mode === 'advise') return { ...base, final: rule, override: 'advise_mode' };
  if (probability < cfg.steer_min_probability)
    return { ...base, final: rule, override: 'below_threshold' };
  if (!IMPLEMENTED_MOVES.has(pick)) return { ...base, final: rule, override: 'unavailable' };
  if (!allowed.has(pick)) return { ...base, final: rule, override: 'not_allowed' };
  return { ...base, final: pick };
}
