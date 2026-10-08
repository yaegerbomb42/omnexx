import type { OmnexxConfig } from '../config/schema.js';
import type { EventLog } from '../core/events.js';
import type { ResolvedModel } from '../providers/pricing.js';
import type { Judge } from '../judge/types.js';
import { ACTION_HINT, ACTION_ROLE, type RouteAction } from './actions.js';
import { describe, listCandidates, unfit, type Candidate, type Needs } from './candidates.js';

export interface RouteContext {
  action: RouteAction;
  needs?: Needs;
  /** Compact, redacted facts for the judge: task title, attempts, last failure, budget left… */
  facts?: Record<string, unknown>;
}

export interface RouteDecision {
  action: RouteAction;
  /** First entry is the pick; the rest is the role chain as failover. */
  chain: ResolvedModel[];
  by: 'pin' | 'judge' | 'rules';
  probability?: number;
  ms: number;
  reason?: string;
}

export interface RouterDeps {
  config: OmnexxConfig;
  /** The fail-open judge, or undefined when routing never asks one. */
  judge?: Judge & { enabled?: (use: 'route') => boolean };
  roleChains: Record<'planner' | 'worker' | 'cheap', ResolvedModel[]>;
  events?: EventLog;
  now: () => number;
  /** Models out of quota: never offered to the judge, so it picks among ones that can answer. */
  modelExhausted?: (ref: string) => boolean;
}

/**
 * Picks the model for an action: a pin wins; otherwise the judge (Nimble) chooses among the
 * user's models that fit the action's needs; otherwise, or when it abstains or isn't confident,
 * the action's role chain. The judge is advisory over a pre-filtered list, so it can never
 * pick a model that lacks a needed capability.
 */
export class ModelRouter {
  private readonly candidates: Candidate[];

  constructor(private readonly deps: RouterDeps) {
    this.candidates = listCandidates(deps.config);
  }

  get mode(): 'rules' | 'judge' {
    const r = this.deps.config.router;
    if (r.kind === 'rules' || !this.deps.judge) return 'rules';
    if (r.kind === 'judge') return 'judge';
    return this.deps.config.judge.kind === 'nimble' ? 'judge' : 'rules';
  }

  async pick(ctx: RouteContext): Promise<RouteDecision> {
    const start = this.deps.now();
    const decision = await this.decide(ctx, start);
    this.deps.events?.emit('route.decision', {
      action: decision.action,
      model: decision.chain[0]
        ? `${decision.chain[0].provider}:${decision.chain[0].id}`
        : undefined,
      by: decision.by,
      ...(decision.probability !== undefined ? { probability: decision.probability } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      ms: decision.ms,
    });
    return decision;
  }

  private async decide(ctx: RouteContext, start: number): Promise<RouteDecision> {
    const roleChain = this.deps.roleChains[ACTION_ROLE[ctx.action]];
    const elapsed = (): number => this.deps.now() - start;
    const done = (
      pick: ResolvedModel | undefined,
      by: RouteDecision['by'],
      extra: Partial<RouteDecision> = {},
    ): RouteDecision => ({
      action: ctx.action,
      chain: pick ? [pick, ...roleChain.filter((m) => !same(m, pick))] : roleChain,
      by,
      ms: elapsed(),
      ...extra,
    });

    const pinned = this.deps.config.router.pin[ctx.action];
    if (pinned) {
      const c = this.candidates.find((x) => x.ref === pinned);
      if (c) return done(c.model, 'pin');
    }

    const needs = ctx.needs ?? {};
    const fit = this.candidates.filter(
      (c) => !unfit(c, needs) && !this.deps.modelExhausted?.(`${c.model.provider}:${c.model.id}`),
    );
    // Rules: keep the role chain, but skip models that can't do the action when others can.
    const ruleChain = (): RouteDecision => {
      const usable = roleChain.filter((m) => fit.some((c) => same(c.model, m)));
      let fallback = roleChain;
      if (usable.length) fallback = usable;
      else if (fit.length) fallback = fit.map((c) => c.model);
      return { action: ctx.action, chain: fallback, by: 'rules', ms: elapsed() };
    };

    if (this.mode === 'rules' || fit.length < 2 || !this.deps.judge) return ruleChain();
    if (this.deps.judge.enabled && !this.deps.judge.enabled('route')) return ruleChain();

    const options = fit.map((c) => c.ref);
    const result = await this.deps.judge.ask(
      'route',
      {
        action: ctx.action,
        about: ACTION_HINT[ctx.action],
        ...ctx.facts,
        models: fit.map(describe),
      },
      [
        {
          id: 'model',
          type: 'choice',
          prompt: `Which model should handle this action? Prefer the cheapest and fastest model that will very likely succeed at "${ACTION_HINT[ctx.action]}"; pick a stronger model for hard reasoning or after repeated failures.`,
          options,
        },
      ],
    );
    if (result.status !== 'answered') {
      return { ...ruleChain(), reason: `judge abstained: ${result.reason}` };
    }
    const a = result.answers.find((x) => x.id === 'model');
    if (a?.type !== 'choice') return { ...ruleChain(), reason: 'no route answer' };
    const p = a.probabilities[a.choice] ?? a.confidence;
    const min = this.deps.config.router.min_probability;
    if (p < min) return { ...ruleChain(), reason: `judge unsure (p=${p.toFixed(2)} < ${min})` };
    const chosen = fit.find((c) => c.ref === a.choice);
    if (!chosen) return { ...ruleChain(), reason: 'judge picked an unknown model' };
    return done(chosen.model, 'judge', { probability: p });
  }
}

function same(a: ResolvedModel, b: ResolvedModel): boolean {
  return a.provider === b.provider && a.id === b.id;
}
