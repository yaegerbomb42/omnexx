import type { PlanNode } from '../core/plan.js';
import type { StuckFinding } from './stuck.js';

/**
 * The strategy ladder (plan §3.10) as an ordered list of rung objects. A task starts on rung 0;
 * every stuck finding moves it one rung up. A rung that isn't implemented yet ("try a different
 * approach" via the planner) is simply not in the list.
 */
export interface Rung {
  id: 'retry_with_evidence' | 'escalate_model' | 'replan_task' | 'park';
  /** Mutates the task; returns a short description for the event log. */
  apply(task: PlanNode, findings: readonly StuckFinding[]): string;
}

export const retryWithEvidence: Rung = {
  id: 'retry_with_evidence',
  apply(task) {
    // Evidence (failures, rejected-patch summary, approaches tried) is already attached in RECORD;
    // this rung makes the "do not repeat" instruction explicit for the next attempt.
    const last = task.approachesTried.at(-1);
    if (last) task.evidence = [...task.evidence, `Do not repeat this approach: ${last}`].slice(-3);
    return 'retry with evidence';
  },
};

/**
 * Rung 2: move the task to the planner (strong) model. The stuck counters restart so the strong
 * model gets its own budget of attempts before the next rung; approaches tried and evidence stay.
 */
export const escalateModel: Rung = {
  id: 'escalate_model',
  apply(task) {
    task.escalated = true;
    task.rungStartedAt = task.attempts;
    task.consecutiveRejections = 0;
    task.failureSignatures = [];
    task.evidence = [
      ...task.evidence,
      'This task is now handled by a stronger model after repeated failures. Re-read the evidence and take a different approach.',
    ].slice(-3);
    return 'escalated to the planner model';
  },
};

/**
 * Rung 3: ask the planner to split the task. The split itself needs the planner model, so the
 * supervisor performs it when it sees this rung (and parks the task if the planner can't).
 */
export const replanTask: Rung = {
  id: 'replan_task',
  apply() {
    return 'split requested';
  },
};

export const park: Rung = {
  id: 'park',
  apply(task, findings) {
    task.status = 'parked';
    task.parkedReason =
      findings.map((f) => `${f.signal}: ${f.detail}`).join('; ') || 'parked by the ladder';
    return `parked (${task.parkedReason})`;
  },
};

export const LADDER: readonly Rung[] = [retryWithEvidence, escalateModel, replanTask, park];

/** Apply the next rung when stuck signals fired; returns the rung applied, if any. */
export function climb(
  task: PlanNode,
  findings: readonly StuckFinding[],
  ladder: readonly Rung[] = LADDER,
): { rung: Rung; detail: string } | undefined {
  if (!findings.length) return undefined;
  const next = Math.min(task.rung + 1, ladder.length - 1);
  task.rung = next;
  task.rungStartedAt = task.attempts;
  const rung = ladder[next];
  if (!rung) return undefined;
  return { rung, detail: rung.apply(task, findings) };
}
