import type { OmnexxConfig } from '../config/schema.js';
import { applyPlanUpdate, type Plan } from './plan.js';
import { inferCheckCommand, inferGoalChecks } from '../verify/acceptance-checks.js';

/**
 * The fast path: before planning, one worker tries the whole goal as a single task, gated and
 * reviewed like any other cycle. Small goals finish there at a fraction of a planned run's cost
 * (on the bench, planning a one-file fix cost 3-5x a single pass). When it doesn't get there in
 * `[plan] fast_attempts` cycles, the planner takes over from the code as it is.
 */
export const FAST_TASK = 'M1.T01';

/** Whether this run starts on the fast path. */
export function tryFastPath(config: OmnexxConfig, goal: string): boolean {
  const p = config.plan;
  if (p.mode === 'full') return false;
  if (p.mode === 'fast') return true;
  // Auto: long goals (a spec, a multi-hour build), autonomous runs and runs where the user sized
  // the plan want milestones from the start.
  return (
    goal.trim().length <= p.fast_max_goal_chars &&
    !config.autonomous.enabled &&
    p.milestones === undefined
  );
}

/** Extracts bulleted acceptance or success criteria from goal markdown if present. */
export function extractCriteria(goal: string): string[] {
  const lines = goal.split('\n');
  const bullets: string[] = [];
  let inCriteria = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#+\s*(success criteria|acceptance criteria|done when)/i.test(trimmed)) {
      inCriteria = true;
      continue;
    }
    if (inCriteria && /^#+\s+/.test(trimmed)) {
      inCriteria = false;
    }
    if (inCriteria && /^[-*]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*]\s+/, '').trim();
      if (item) bullets.push(item);
    }
  }
  return bullets;
}

/** One milestone with one task: the whole goal, done when every gate passes. */
export function fastPlan(config: OmnexxConfig, goal: string): Plan {
  const gateChecks = config.gates.map((g) => g.run);
  const what = goal.trim().replace(/\s+/g, ' ');
  const parsedCriteria = extractCriteria(goal);
  const acceptance =
    parsedCriteria.length > 0
      ? parsedCriteria
      : [what.length > 480 ? `${what.slice(0, 477)}...` : what];
  const derivedChecks = parsedCriteria
    .map((c) => inferCheckCommand(c))
    .filter((c): c is string => c !== undefined);
  const goalChecks = inferGoalChecks(goal);
  const checks = Array.from(new Set([...derivedChecks, ...goalChecks, ...gateChecks])).slice(0, 10);
  return applyPlanUpdate(
    undefined,
    {
      milestones: [
        {
          id: 'M1',
          title: 'The goal',
          checks,
          tasks: [
            {
              id: FAST_TASK,
              title: 'Do the whole goal in one pass',
              why: 'Fast path: the whole goal in one pass; the planner takes over if it fails.',
              acceptance,
              checks,
              size: 'L',
            },
          ],
        },
      ],
    },
    goal.trim(),
  );
}

/** True when the fast path has had its tries without finishing and planning should take over. */
export function fastPathSpent(plan: Plan, attempts: number): boolean {
  const t = plan.nodes.find((n) => n.id === FAST_TASK);
  if (!t) return false;
  return t.status !== 'done' && (t.status === 'parked' || t.attempts >= attempts);
}
