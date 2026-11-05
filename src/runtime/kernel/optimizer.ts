/**
 * General-agent allocation optimizer: a turn-0 task classifier, a phase state machine, a
 * VoI + KV-cache cadence controller, and a discounted-UCB capability bandit.
 *
 * Everything here is pure heuristics + arithmetic (sub-millisecond); nothing blocks a turn.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CACHE_READ_PRICE, CACHE_WRITE_PRICE } from './cache-epoch.js';

export type TaskClass = 'trivial' | 'standard' | 'deliberative';
export type Phase = 'orient' | 'plan' | 'act' | 'verify' | 'synthesize';
export type CadenceAction =
  | 'stay_sticky'
  | 'reselect_append_only'
  | 'rebake_epoch'
  | 'compact_gc'
  | 'escalate_mode'
  | 'verify_now';
export type CadenceReason =
  | 'task_start'
  | 'phase_shift'
  | 'objective_drift'
  | 'tool_miss'
  | 'friction_spike'
  | 'agent_requested'
  | 'sticky_progress';

export interface TaskProfile {
  taskClass: TaskClass;
  /** Coarse intent bucket used as the bandit context. */
  intent: string;
  /** Top-K mount budget for this class. */
  topK: number;
  /** Per-turn output token ceiling (undefined = caller default). */
  maxTokens?: number;
  /** Whether a real verification is required after mutations before completion. */
  requireVerify: boolean;
  /** Minimum reasoning tier. */
  minTier: 0 | 1 | 2;
  ms: number;
}

const DELIBERATIVE =
  /\b(refactor|migrat\w*|architect\w*|redesign|race condition|flaky|deadlock|memory leak|performance|optimi[sz]\w*|security audit|across the (repo|codebase)|multi-?step|end[- ]to[- ]end|rewrite)\b/i;
const MUTATING_INTENT =
  /\b(fix|implement|add|create|build|change|update|write|edit|remove|delete|rename|refactor|migrate|deploy|open (a )?pr|commit|bump)\b/i;
const QUESTION =
  /^(what|why|how|when|where|who|which|is|are|does|do|can|could|explain|summari[sz]e|tell me)\b/i;
const INTENTS: [string, RegExp][] = [
  ['bugfix', /\b(bug|fix|error|crash|fail\w*|broken|regression|exception|stack ?trace)\b/i],
  ['feature', /\b(implement|add|feature|support|build|create)\b/i],
  [
    'external',
    /\b(github|gitlab|jira|linear|slack|sentry|notion|postgres|database|sql|aws|gcp|stripe|figma|browser|email|calendar|api)\b/i,
  ],
  ['refactor', /\b(refactor|clean ?up|rename|migrat\w*|restructure)\b/i],
  ['docs', /\b(docs?|readme|document\w*|changelog)\b/i],
  ['test', /\b(tests?|coverage|spec)\b/i],
  ['question', QUESTION],
];

/** Turn-0 classifier (regex + length; well under 1ms). */
export function classifyTask(objective: string): TaskProfile {
  const t0 = performance.now();
  const text = objective.trim();
  const intent = INTENTS.find(([, re]) => re.test(text))?.[0] ?? 'general';
  const words = text.split(/\s+/).filter(Boolean).length;
  let taskClass: TaskClass;
  if (DELIBERATIVE.test(text) || words > 160) taskClass = 'deliberative';
  else if ((QUESTION.test(text) && !MUTATING_INTENT.test(text) && words < 40) || words <= 6)
    taskClass = 'trivial';
  else taskClass = 'standard';
  const base = { intent, ms: performance.now() - t0 };
  if (taskClass === 'trivial')
    return { ...base, taskClass, topK: 4, maxTokens: 1200, requireVerify: false, minTier: 0 };
  if (taskClass === 'deliberative')
    return { ...base, taskClass, topK: 8, requireVerify: true, minTier: 2 };
  return { ...base, taskClass, topK: 6, requireVerify: true, minTier: 0 };
}

const VERIFY_CMD =
  /\b(vitest|jest|mocha|pytest|tox|nox|go test|cargo (test|check|clippy)|tsc\b|typecheck|eslint|biome|ruff|mypy|pyright|flake8|lint|make (test|check)|gradle\w* test|mvn (test|verify)|dotnet test|rspec|phpunit|npm (run )?(test|build|check)|pnpm (run )?(test|build|check)|yarn (test|build|check)|bun test|build)\b/i;
const TRIVIAL_CMD = /^\s*(echo|ls|pwd|cat|true|printf|which|whoami|date|head|tail|wc)\b/i;

/** A tool call counts as verification only when it runs a real checker (never echo/ls). */
export function isRealVerification(tool: string, input: unknown): boolean {
  if (/^(run_tests?|verify|typecheck|spec_tests|lint)$/i.test(tool)) return true;
  if (tool !== 'bash' && tool !== 'shell' && tool !== 'run') return false;
  const cmd =
    input && typeof input === 'object' && 'command' in input
      ? String(input.command)
      : typeof input === 'string'
        ? input
        : '';
  const parts = cmd
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.some((p) => !TRIVIAL_CMD.test(p) && VERIFY_CMD.test(p));
}

const READ_TOOLS =
  /^(read|search|outline|grep|glob|list|find|view|manage_capabilities|search_capabilities)$/i;
const PLAN_TOOLS = /^(todo\w*|plan\w*|update_plan|running_context|note\w*)$/i;
const MUTATE_TOOLS =
  /^(edit|write|str_replace|apply_patch|create_file|delete_file|rename|multi_edit|insert)$/i;

export interface PhaseEvent {
  tool: string;
  input: unknown;
  isError: boolean;
}

/** orient -> plan -> act -> verify -> synthesize; trivial tasks skip plan/verify. */
export class PhaseMachine {
  phase: Phase = 'orient';
  private reads = 0;
  private mutationsSinceVerify = 0;
  private verified = false;
  constructor(private readonly profile: TaskProfile) {
    if (profile.taskClass === 'trivial') this.phase = 'orient';
  }

  get needsVerify(): boolean {
    return this.profile.requireVerify && this.mutationsSinceVerify > 0;
  }

  get isVerified(): boolean {
    return this.verified && this.mutationsSinceVerify === 0;
  }

  observe(e: PhaseEvent): Phase {
    const prev = this.phase;
    const mutating =
      MUTATE_TOOLS.test(e.tool) ||
      (e.tool.startsWith('mcp__') && !/__(get|list|search|read|fetch|query)/i.test(e.tool));
    if (isRealVerification(e.tool, e.input)) {
      if (!e.isError) {
        this.verified = true;
        this.mutationsSinceVerify = 0;
        this.phase = 'synthesize';
      } else this.phase = 'act';
    } else if (mutating && !e.isError) {
      this.mutationsSinceVerify += 1;
      this.verified = false;
      this.phase = this.profile.requireVerify ? 'act' : 'synthesize';
    } else if (PLAN_TOOLS.test(e.tool) && this.phase === 'orient') {
      this.phase = this.profile.taskClass === 'trivial' ? 'synthesize' : 'plan';
    } else if (READ_TOOLS.test(e.tool)) {
      this.reads += 1;
      if (this.phase === 'orient' && this.reads >= 3)
        this.phase = this.profile.taskClass === 'trivial' ? 'synthesize' : 'plan';
    }
    return prev === this.phase ? prev : this.phase;
  }

  /** Called at the start of a turn: act -> verify once mutations settled for a turn. */
  tick(mutatedLastTurn: boolean): Phase {
    if (this.phase === 'act' && this.needsVerify && !mutatedLastTurn) this.phase = 'verify';
    return this.phase;
  }
}

export interface CadenceInput {
  newTask: boolean;
  phaseShift: boolean;
  /** 0..1 lexical drift of the current objective vs the last selection query. */
  drift: number;
  toolMiss: boolean;
  frictionScore: number;
  agentRequested: boolean;
  /** Tokens before the mount point that a re-bake would rewrite. */
  prefixTokens: number;
  /** Tokens a reselect would add to the per-turn uncached directive. */
  directiveTokens: number;
  expectedRemainingTurns: number;
  needsVerify: boolean;
  /** Freed tokens a GC would yield right now. */
  gcFreeTokens: number;
  taskClass: TaskClass;
}

export interface CadenceDecision {
  action: CadenceAction;
  reason: CadenceReason;
  /** J score of the chosen action (token-equivalents; higher is better). */
  j: number;
  scores: Record<CadenceAction, number>;
}

export const CADENCE_LAMBDA = { tok: 1, cache: 1, lat: 2 } as const;

/**
 * J(s,a) = E[dQuality] - λ_tok·dTokens - λ_cache·prefixBustCost - λ_lat·dLatencyMs, in
 * token-equivalents. dQuality is the expected tokens saved by not flailing (a miss or
 * friction costs ~ a wasted turn of prompt).
 */
export function decideCadence(i: CadenceInput): CadenceDecision {
  const turnCost = Math.max(2_000, i.prefixTokens) * CACHE_READ_PRICE + 400;
  const reason: CadenceReason = i.newTask
    ? 'task_start'
    : i.agentRequested
      ? 'agent_requested'
      : i.toolMiss
        ? 'tool_miss'
        : i.frictionScore >= 2
          ? 'friction_spike'
          : i.phaseShift
            ? 'phase_shift'
            : i.drift > 0.5
              ? 'objective_drift'
              : 'sticky_progress';
  const pNeed =
    (i.newTask ? 1 : 0) ||
    Math.min(
      1,
      (i.agentRequested ? 0.6 : 0) +
        (i.toolMiss ? 0.5 : 0) +
        Math.min(0.5, 0.2 * i.frictionScore) +
        (i.phaseShift ? 0.3 : 0) +
        0.6 * i.drift,
    );
  const quality = pNeed * turnCost * Math.min(6, i.expectedRemainingTurns);
  const bust = i.prefixTokens * (CACHE_WRITE_PRICE - CACHE_READ_PRICE);
  const s: Record<CadenceAction, number> = {
    stay_sticky: 0,
    reselect_append_only:
      quality -
      CADENCE_LAMBDA.tok * i.directiveTokens * i.expectedRemainingTurns * (1 - CACHE_READ_PRICE) -
      CADENCE_LAMBDA.lat * 5,
    rebake_epoch: quality - CADENCE_LAMBDA.cache * bust - CADENCE_LAMBDA.lat * 5,
    compact_gc:
      i.gcFreeTokens * i.expectedRemainingTurns * CACHE_READ_PRICE -
      CADENCE_LAMBDA.cache * bust -
      CADENCE_LAMBDA.lat * 2,
    escalate_mode:
      i.taskClass !== 'trivial' && i.frictionScore >= 3 ? turnCost * 3 - 1_500 : -Infinity,
    verify_now: i.needsVerify ? turnCost * 4 : -Infinity,
  };
  if (i.newTask) s.rebake_epoch = Math.max(s.rebake_epoch, s.reselect_append_only + 1);
  let action: CadenceAction = 'stay_sticky';
  for (const a of Object.keys(s) as CadenceAction[]) if (s[a] > s[action]) action = a;
  return {
    action,
    reason: action === 'stay_sticky' ? 'sticky_progress' : reason,
    j: s[action],
    scores: s,
  };
}

/** Jaccard distance between two token sets (objective drift). */
export function lexicalDrift(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const tb = new Set(b.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  if (!ta.size || !tb.size) return ta.size === tb.size ? 0 : 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return 1 - inter / (ta.size + tb.size - inter);
}

interface Arm {
  pulls: number;
  progressReward: number;
  tokenCost: number;
  latencyMs: number;
}

/** Discounted UCB over (intentBucket, capabilityId | reasoningMode). */
export class CapabilityBandit {
  private arms = new Map<string, Arm>();
  private dirty = false;
  constructor(
    private readonly path?: string,
    readonly gamma = 0.97,
    private readonly c = 0.5,
  ) {
    if (path) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { arms?: Record<string, Arm> };
        for (const [k, v] of Object.entries(raw.arms ?? {}))
          if (typeof v.pulls === 'number' && Number.isFinite(v.pulls)) this.arms.set(k, v);
      } catch {
        // missing or corrupt: start empty
      }
    }
  }

  private key(intent: string, arm: string): string {
    return `${intent}|${arm}`;
  }

  /** Discount every arm in a context (call once per turn). */
  decay(intent: string): void {
    const prefix = `${intent}|`;
    for (const [k, a] of this.arms)
      if (k.startsWith(prefix)) {
        a.pulls *= this.gamma;
        a.progressReward *= this.gamma;
        a.tokenCost *= this.gamma;
        a.latencyMs *= this.gamma;
      }
  }

  update(
    intent: string,
    arm: string,
    r: { progress: number; tokens?: number; latencyMs?: number },
  ): void {
    const k = this.key(intent, arm);
    const a = this.arms.get(k) ?? { pulls: 0, progressReward: 0, tokenCost: 0, latencyMs: 0 };
    a.pulls += 1;
    a.progressReward += r.progress;
    a.tokenCost += r.tokens ?? 0;
    a.latencyMs += r.latencyMs ?? 0;
    this.arms.set(k, a);
    this.dirty = true;
  }

  /** UCB score in [0, ~1.5]; unseen arms get a mild optimism bonus. */
  score(intent: string, arm: string): number {
    const a = this.arms.get(this.key(intent, arm));
    let total = 0;
    const prefix = `${intent}|`;
    for (const [k, v] of this.arms) if (k.startsWith(prefix)) total += v.pulls;
    if (!a || a.pulls < 1e-6) return 0.5 * this.c;
    const mean = a.progressReward / a.pulls;
    return mean + this.c * Math.sqrt(Math.log(1 + total) / a.pulls);
  }

  /** Multiplicative prior for chooseMountSet: 0 for unseen, ±0.3 for learned arms. */
  bonus(intent: string, arm: string): number {
    const a = this.arms.get(this.key(intent, arm));
    if (!a || a.pulls < 0.5) return 0;
    return 0.6 * (a.progressReward / a.pulls) - 0.3;
  }

  top(limit = 5): { arm: string; pulls: number; mean: number }[] {
    return [...this.arms.entries()]
      .filter(([, a]) => a.pulls >= 0.5)
      .map(([arm, a]) => ({
        arm,
        pulls: Number(a.pulls.toFixed(2)),
        mean: Number((a.progressReward / a.pulls).toFixed(3)),
      }))
      .sort((x, y) => y.mean * Math.log1p(y.pulls) - x.mean * Math.log1p(x.pulls))
      .slice(0, limit);
  }

  /** Persist atomically; a read-only or ephemeral dir is a silent no-op. */
  save(): void {
    if (!this.path || !this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${String(process.pid)}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ version: 1, gamma: this.gamma, arms: Object.fromEntries(this.arms) }),
      );
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {
      // read-only / ephemeral: keep in memory only
    }
  }
}

export interface OptimizerSnapshot {
  taskClass: TaskClass;
  intent: string;
  phase: Phase;
  cadence?: CadenceDecision | undefined;
  topPriors: { arm: string; pulls: number; mean: number }[];
}

/** Ties classifier, phase machine, cadence and bandit together for the kernel. */
export class GeneralAgentOptimizer {
  profile: TaskProfile = classifyTask('');
  phases = new PhaseMachine(this.profile);
  readonly bandit: CapabilityBandit;
  lastCadence: CadenceDecision | undefined;
  private mutatedThisTurn = false;
  private lastPhase: Phase = 'orient';
  agentRequested = false;

  constructor(opts: { banditPath?: string | undefined } = {}) {
    this.bandit = new CapabilityBandit(opts.banditPath);
  }

  startTask(objective: string): TaskProfile {
    this.profile = classifyTask(objective);
    this.phases = new PhaseMachine(this.profile);
    this.lastPhase = this.phases.phase;
    return this.profile;
  }

  /** Start of a turn: advance the phase clock; returns whether the phase changed. */
  beginTurn(): { phase: Phase; shifted: boolean } {
    const phase = this.phases.tick(this.mutatedThisTurn);
    this.mutatedThisTurn = false;
    const shifted = phase !== this.lastPhase;
    this.lastPhase = phase;
    this.bandit.decay(this.profile.intent);
    return { phase, shifted };
  }

  observeTool(e: PhaseEvent & { usedCapabilities: readonly string[]; progress: number }): void {
    if (MUTATE_TOOLS.test(e.tool) && !e.isError) this.mutatedThisTurn = true;
    if (/^(manage_capabilities|search_capabilities|mount_capability)$/.test(e.tool))
      this.agentRequested = true;
    this.phases.observe(e);
    for (const id of e.usedCapabilities)
      this.bandit.update(this.profile.intent, id, { progress: e.isError ? 0 : e.progress });
  }

  rewardMode(mode: string, progress: number): void {
    this.bandit.update(this.profile.intent, `mode:${mode}`, { progress });
  }

  snapshot(): OptimizerSnapshot {
    return {
      taskClass: this.profile.taskClass,
      intent: this.profile.intent,
      phase: this.phases.phase,
      cadence: this.lastCadence,
      topPriors: this.bandit.top(5),
    };
  }
}
