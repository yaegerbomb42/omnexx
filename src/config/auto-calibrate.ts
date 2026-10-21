import type { OmnexxPaths } from '../core/paths.js';
import type { Roles } from '../config/roles.js';
import { ROLES_VERSION, writeRoles } from '../config/roles.js';
import { writePool } from '../config/ranking.js';

export interface AutoCalibrateResult {
  pool: string[];
  roles: Roles;
  summary: string;
}

/**
 * Classifies model refs based on known strength, reasoning, speed, and cost profiles.
 */
function scoreModel(ref: string): {
  capability: number;
  speed: number;
  cost: number;
  reasoning: boolean;
} {
  const lower = ref.toLowerCase();
  const isReasoning =
    lower.includes('mercury') ||
    lower.includes('r1') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('thinking') ||
    lower.includes('sonnet') ||
    lower.includes('opus');
  const isFreeOrCheap =
    lower.endsWith(':free') ||
    lower.includes('mercury') ||
    lower.includes('flash') ||
    lower.includes('haiku') ||
    lower.includes('mini') ||
    lower.includes('groq') ||
    lower.includes('cerebras');

  let capability = 5;
  if (
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('mercury-3') ||
    lower.includes('r1')
  ) {
    capability = 9;
  } else if (
    lower.includes('codestral') ||
    lower.includes('qwen-2.5-coder') ||
    lower.includes('gpt-4o')
  ) {
    capability = 8;
  } else if (lower.includes('flash') || lower.includes('haiku')) {
    capability = 7;
  }

  const speed = isFreeOrCheap ? 9 : 6;
  const cost = isFreeOrCheap ? 1 : 8;

  return { capability, speed, cost, reasoning: isReasoning };
}

/**
 * Inspects all available model references and assigns optimal roles automatically.
 */
export async function autoCalibrateModels(
  paths: OmnexxPaths,
  availableRefs: readonly string[],
): Promise<AutoCalibrateResult> {
  const distinct = Array.from(new Set(availableRefs.filter((r) => r.includes(':'))));
  const fallbackRef = distinct[0];
  if (!fallbackRef) {
    throw new Error('No available models found to calibrate. Add at least one provider key first.');
  }

  const scored = distinct.map((ref) => ({ ref, ...scoreModel(ref) }));

  // Planner & Worker want high capability and reasoning
  const heavy = [...scored].sort((a, b) => b.capability - a.capability || a.cost - b.cost);
  // Cheap wants lowest cost and highest speed
  const light = [...scored].sort((a, b) => a.cost - b.cost || b.speed - a.speed);

  const bestWorker = heavy[0]?.ref ?? fallbackRef;
  const bestPlanner = heavy.find((m) => m.reasoning)?.ref ?? heavy[0]?.ref ?? fallbackRef;
  const bestCheap = light[0]?.ref ?? fallbackRef;

  const poolRanked = Array.from(new Set([bestWorker, bestPlanner, bestCheap, ...distinct]));

  const calibratedRoles: Roles = {
    models: {
      chat: [bestWorker],
      worker: [bestWorker],
      planner: [bestPlanner],
      cheap: [bestCheap],
      helpers: [bestWorker],
    },
    strategies: {
      chat: 'fallback',
      worker: 'fallback',
      planner: 'fallback',
      cheap: 'fallback',
      helpers: 'fallback',
    },
    spreadHelpers: true,
  };

  await writePool(paths, poolRanked, 'fallback');
  await writeRoles(paths, { ...calibratedRoles, version: ROLES_VERSION } as unknown as Roles);

  const summary = `Auto-calibrated ${String(distinct.length)} model(s): Worker/Chat → ${bestWorker}, Planner → ${bestPlanner}, Quick Jobs → ${bestCheap}.`;

  return {
    pool: poolRanked,
    roles: calibratedRoles,
    summary,
  };
}
