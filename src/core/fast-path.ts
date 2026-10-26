import type { OmnexxConfig } from '../config/schema.js';
import { applyPlanUpdate, type Plan } from './plan.js';
import { estimateTokens } from './tokens.js';
import { inferCheckCommand, inferGoalChecks } from '../verify/acceptance-checks.js';

/**
 * The fast path: before planning, one worker tries the whole goal as a single task, gated and
 * reviewed like any other cycle. Small goals finish there at a fraction of a planned run's cost
 * (on the bench, planning a one-file fix cost 3-5x a single pass). When it doesn't get there in
 * `[plan] fast_attempts` cycles, the planner takes over from the code as it is.
 */
export const FAST_TASK = 'M1.T01';

/** A token that looks like a file path (has an extension, not a version number). */
const FILE_TOKEN_RE = /^[A-Za-z0-9_.$~/-]+\.[A-Za-z][A-Za-z0-9]*$/;

/** Trivial goals: at most this many words, naming a single file. */
export const TRIVIAL_GOAL_WORDS = 20;
/** Trivial goals name exactly one file: a one-line change to one place. */
export const TRIVIAL_FILE_HITS = 1;

/** Verbs that indicate a specific, narrow edit (not an open-ended feature). */
const TRIVIAL_VERBS: readonly string[] = [
  'bump',
  'fix',
  'update',
  'change',
  'increase',
  'decrease',
  'add',
  'remove',
  'delete',
  'set',
  'correct',
  'patch',
  'tweak',
  'adjust',
  'modify',
  'replace',
  'rename',
];

/**
 * A trivial edit: a short goal that names a single file, e.g. "bump the version in package.json
 * to 2.0.0". These are done by a single-shot worker pass (one edit + the targeted check), not a
 * think-first loop, so quick mode finishes them in a couple of turns instead of a full analysis.
 */
export function isTrivialGoal(goal: string): boolean {
  const words = goal.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > TRIVIAL_GOAL_WORDS) return false;
  const files = new Set(words.filter((w) => FILE_TOKEN_RE.test(w)).map((w) => w.toLowerCase()));
  if (files.size !== TRIVIAL_FILE_HITS) return false;
  const verbs = words.filter((w) => TRIVIAL_VERBS.includes(w.toLowerCase()));
  return verbs.length === 1;
}

/** The single-shot trivial pass: one edit turn plus one fix turn when the targeted check fails. */
export const TRIVIAL_MAX_TURNS = 3;
/** Budget for a trivial pass, including the fixed per-turn overhead and the worker reply. */
export const TRIVIAL_MAX_TOKENS = 8_000;
/** Fixed prompt overhead of one worker turn (system, tools, framing), in tokens. */
const TRIVIAL_FIXED_TOKENS = 800;
/** Output cap estimate for a single worker reply that edits one file. */
const TRIVIAL_OUTPUT_TOKENS = 1_500;

export interface TrivialCost {
  turns: number;
  tokens: number;
}

/**
 * Estimated cost of the single-shot trivial path (token efficiency and speed benchmark). One pass
 * is a single edit turn plus at most one fix turn if the targeted check fails, and its tokens are
 * the fixed overhead plus the tiny goal and a small reply — far under the full plan/verify loop.
 */
export function trivialCost(goal: string): TrivialCost {
  return {
    turns: 2,
    tokens: TRIVIAL_FIXED_TOKENS + estimateTokens(goal) + TRIVIAL_OUTPUT_TOKENS,
  };
}

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
  // Trivial edits (a one-line change to one file) skip the think-first loop and run as a
  // single-shot worker pass; the size marks the task for `usesThinkLoop`.
  const trivial = isTrivialGoal(goal);
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
              size: trivial ? 'S' : 'L',
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
