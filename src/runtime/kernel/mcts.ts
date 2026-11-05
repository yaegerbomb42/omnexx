import type { CapabilityEntry, TelemetrySnapshot, TurnAllocation } from './types.js';

export interface MctsBranch {
  id: string;
  allocation: TurnAllocation;
  /** Higher is better. */
  score: number;
  visits: number;
  reason: string;
}

export interface MctsResult {
  best: TurnAllocation;
  branches: MctsBranch[];
  selectedId: string;
}

export interface MctsOptions {
  branchFactor: number;
  /** Exploration constant for UCB1 (default √2). */
  exploration?: number | undefined;
  /** Simulation iterations beyond the initial expansions (default branchFactor * 4). */
  iterations?: number | undefined;
}

/**
 * Lightweight Monte Carlo Tree Search over turn-allocation branches.
 *
 * Does NOT call the frontier model. Each branch is a concrete TurnAllocation
 * (tool subset + roles + reasoning mode). Rollouts are scored by a deterministic
 * verifier using telemetry, capability coverage, and blast-radius cost — fast enough
 * to run every tier-2 turn without noticeable latency.
 */
export function runMcts(args: {
  seed: TurnAllocation;
  objective: string;
  telemetry: TelemetrySnapshot;
  candidates: readonly CapabilityEntry[];
  options: MctsOptions;
}): MctsResult {
  const k = Math.max(2, Math.min(8, args.options.branchFactor));
  const exploration = args.options.exploration ?? Math.SQRT2;
  const iterations = args.options.iterations ?? k * 4;

  const branches = expandBranches(args.seed, args.candidates, args.objective, k).map((alloc, i) => {
    const score = scoreBranch(alloc, args.objective, args.telemetry, args.candidates);
    return {
      id: `b${i}`,
      allocation: alloc,
      score,
      visits: 1,
      reason: explain(alloc, score),
    } satisfies MctsBranch;
  });

  if (branches.length === 0) {
    return { best: args.seed, branches: [], selectedId: 'seed' };
  }

  // UCB1 selection + resimulate with light noise so visit counts matter.
  for (let t = 0; t < iterations; t++) {
    const totalVisits = branches.reduce((s, b) => s + b.visits, 0);
    let bestIdx = 0;
    let bestUcb = -Infinity;
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i]!;
      const ucb =
        b.score / b.visits + exploration * Math.sqrt(Math.log(totalVisits + 1) / b.visits);
      if (ucb > bestUcb) {
        bestUcb = ucb;
        bestIdx = i;
      }
    }
    const chosen = branches[bestIdx]!;
    // Rescore with a small deterministic jitter keyed by visit count (stable across runs).
    const jittered = scoreBranch(
      chosen.allocation,
      args.objective,
      perturbTelemetry(args.telemetry, chosen.visits),
      args.candidates,
    );
    chosen.score += jittered;
    chosen.visits += 1;
  }

  let winner = branches[0]!;
  for (const b of branches) {
    const avg = b.score / b.visits;
    const winAvg = winner.score / winner.visits;
    if (avg > winAvg) winner = b;
  }

  return {
    best: winner.allocation,
    branches,
    selectedId: winner.id,
  };
}

function expandBranches(
  seed: TurnAllocation,
  candidates: readonly CapabilityEntry[],
  objective: string,
  k: number,
): TurnAllocation[] {
  const tools = candidates.filter((c) => c.kind === 'tool').map((c) => c.id);
  const skills = candidates.filter((c) => c.kind === 'skill').map((c) => c.id);
  const out: TurnAllocation[] = [];

  // Branch 0: the seed itself.
  out.push({
    ...seed,
    mountedTools: [...seed.mountedTools],
    mountedSkills: [...seed.mountedSkills],
  });

  // Branch: read-heavy exploration (low blast).
  out.push({
    ...seed,
    reasoningMode: 'cot',
    activeRoles: ['planner', 'executor'],
    mountedTools: pick(tools, ['read', 'search', 'outline', 'read_symbol'], 4),
    mountedSkills: skills.slice(0, 2),
    maxTokensTurn: Math.min(seed.maxTokensTurn, 2048),
    allowCodeModeBatching: true,
    blastRadius: 'low',
    mctsBranchFactor: seed.mctsBranchFactor,
  });

  // Branch: edit-heavy execution with verifier.
  out.push({
    ...seed,
    reasoningMode: 'reflexion',
    activeRoles: ['executor', 'verifier'],
    mountedTools: pick(tools, ['read', 'str_replace', 'write_file', 'bash', 'search'], 5),
    mountedSkills: skills.slice(0, 2),
    maxTokensTurn: Math.max(seed.maxTokensTurn, 4096),
    allowCodeModeBatching: false,
    blastRadius: /rm\s|migrate|deploy/i.test(objective) ? 'high' : 'medium',
    mctsBranchFactor: seed.mctsBranchFactor,
  });

  // Branch: adversarial critic (high friction recovery).
  out.push({
    ...seed,
    reasoningMode: 'mcts',
    activeRoles: ['planner', 'executor', 'verifier', 'adversarial_critic'],
    mountedTools: pick(tools, ['read', 'search', 'bash', 'str_replace', 'todo'], 5),
    mountedSkills: skills.slice(0, 3),
    maxTokensTurn: 4096,
    allowCodeModeBatching: false,
    blastRadius: 'medium',
    mctsBranchFactor: seed.mctsBranchFactor,
  });

  // Branch: minimal fast path.
  out.push({
    ...seed,
    tier: 0,
    reasoningMode: 'zero-shot',
    activeRoles: ['executor'],
    mountedTools: pick(tools, ['read', 'bash'], 3),
    mountedSkills: [],
    maxTokensTurn: 1024,
    allowCodeModeBatching: true,
    blastRadius: 'low',
  });

  // Extra branches: rotate tool windows over the candidate list.
  for (let i = 0; out.length < k && i < tools.length; i++) {
    const window = tools.slice(i, i + 4);
    if (window.length === 0) break;
    out.push({
      ...seed,
      mountedTools: window,
      mountedSkills: skills.slice(0, 1),
      activeRoles: ['executor', 'verifier'],
      reasoningMode: i % 2 === 0 ? 'cot' : 'reflexion',
      blastRadius: 'medium',
    });
  }

  return out.slice(0, k);
}

function pick(available: readonly string[], preferred: readonly string[], max: number): string[] {
  const set = new Set(available);
  const out: string[] = [];
  for (const p of preferred) {
    if (set.has(p) && out.length < max) out.push(p);
  }
  for (const a of available) {
    if (!out.includes(a) && out.length < max) out.push(a);
  }
  return out;
}

/**
 * Verifier score in roughly [-5, +10]. Rewards coverage of the objective's implied
 * needs, presence of verifier under friction, and punishes high blast at high friction.
 */
export function scoreBranch(
  alloc: TurnAllocation,
  objective: string,
  telemetry: TelemetrySnapshot,
  candidates: readonly CapabilityEntry[],
): number {
  let score = 0;
  const obj = objective.toLowerCase();
  const toolSet = new Set(alloc.mountedTools);

  if (/test|lint|typecheck|build|compile/.test(obj) && toolSet.has('bash')) score += 2;
  if (
    /read|inspect|explain|where|find|search/.test(obj) &&
    (toolSet.has('read') || toolSet.has('search'))
  )
    score += 2;
  if (
    /edit|fix|implement|write|refactor|change/.test(obj) &&
    (toolSet.has('str_replace') || toolSet.has('write_file'))
  )
    score += 2;

  // Capability description overlap.
  for (const c of candidates) {
    if (c.kind !== 'tool' || !toolSet.has(c.id)) continue;
    const desc = `${c.name} ${c.description}`.toLowerCase();
    if (obj.split(/\s+/).some((w) => w.length > 3 && desc.includes(w))) score += 0.35;
  }

  if (telemetry.frictionScore >= 2 && alloc.activeRoles.includes('verifier')) score += 1.5;
  if (telemetry.frictionScore >= 3 && alloc.activeRoles.includes('adversarial_critic'))
    score += 1.5;
  if (telemetry.frictionScore >= 2 && alloc.reasoningMode === 'zero-shot') score -= 1.5;
  if (telemetry.contextPressure >= 0.85 && alloc.maxTokensTurn > 2048) score -= 1;
  if (telemetry.contextPressure >= 0.85 && alloc.tier === 3) score += 1;
  if (alloc.blastRadius === 'high' && telemetry.frictionScore >= 2) score -= 2;
  if (alloc.blastRadius === 'low' && /delete|rm |migrate|production/.test(obj)) score -= 1;
  if (alloc.allowCodeModeBatching && telemetry.contextPressure < 0.5) score += 0.5;
  if (alloc.mountedTools.length === 0) score -= 3;
  if (alloc.mountedTools.length > 10) score -= 0.5;

  return score;
}

function perturbTelemetry(t: TelemetrySnapshot, visits: number): TelemetrySnapshot {
  // Tiny deterministic drift so resimulations are not identical; stays stable across processes.
  const d = ((visits * 17) % 7) * 0.05;
  return {
    ...t,
    frictionScore: Math.max(0, t.frictionScore + (visits % 2 === 0 ? d : -d)),
    contextPressure: Math.min(
      2,
      Math.max(0, t.contextPressure + (visits % 3 === 0 ? 0.02 : -0.02)),
    ),
  };
}

function explain(alloc: TurnAllocation, score: number): string {
  return `${alloc.reasoningMode}/${alloc.activeRoles.join('+')}/tools=${alloc.mountedTools.length}/blast=${alloc.blastRadius}/score=${score.toFixed(2)}`;
}
