import type { PlanNode } from '../core/plan.js';
import type { RouteAction } from './actions.js';
import type { RouteContext } from './router.js';

/** The action for a worker cycle on `task`, from its kind, size and history. */
export function cycleAction(task: PlanNode): RouteAction {
  if (task.consecutiveRejections > 0 || task.failureSignatures.length > 0) return 'debug-failure';
  switch (task.kind) {
    case 'tests':
      return 'write-tests';
    case 'refactor':
    case 'migration':
      return 'refactor';
    case 'docs':
      return 'docs';
    case 'investigate':
      return 'read-explore';
    case 'lint':
      return 'edit-small';
    default:
      return task.size === 'S' ? 'edit-small' : 'edit-large';
  }
}

/** Route context for a worker cycle. An escalated task only gets high-quality models. */
export function cycleRoute(task: PlanNode, budgetLeft: number): RouteContext {
  return {
    action: cycleAction(task),
    needs: { tools: true, ...(task.escalated ? { minQuality: 'high' as const } : {}) },
    facts: {
      task: `${task.id} ${task.title}`.slice(0, 200),
      kind: task.kind,
      size: task.size,
      attempts: task.attempts,
      consecutiveRejections: task.consecutiveRejections,
      lastRejection: task.lastRejection?.slice(0, 300),
      ladderRung: task.rung,
      escalated: task.escalated,
      budgetLeft: Math.round(budgetLeft * 100) / 100,
    },
  };
}
