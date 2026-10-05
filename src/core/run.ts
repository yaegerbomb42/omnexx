import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDuration } from '../config/duration.js';
import type { OmnexxConfig } from '../config/schema.js';
import { StateError } from '../errors.js';
import { createJudge } from '../judge/factory.js';
import type { FailOpenJudge } from '../judge/fail-open.js';
import { LlmJudge } from '../judge/llm.js';
import { preflight, spentInWindow } from '../guard/budget.js';
import { costUsd, resolveModel, type ResolvedModel } from '../providers/pricing.js';
import type { Provider, Usage } from '../providers/types.js';
import { scrubEnv } from '../security/env-scrub.js';
import type { PolicyContext } from '../security/command-policy.js';
import { Redactor } from '../security/redact.js';
import type { ControlSignal } from '../agent/loop.js';
import type { Clock } from './clock.js';
import { EventLog } from './events.js';
import { runShell, type Executor } from './exec.js';
import type { OmnexxPaths } from './paths.js';
import type { Plan } from './plan.js';
import { RunStore, type Phase, type RunState } from './run-store.js';

export interface RunHooks {
  /** Called after a phase transition is persisted, before its side effects. Chaos tests kill here. */
  onPhase?: (phase: Phase, cycle: number) => Promise<void> | void;
}

export interface RunDeps {
  config: OmnexxConfig;
  paths: OmnexxPaths;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  provider: Provider;
  fetch: typeof fetch;
  /** Secrets that must never appear anywhere (the API key). */
  secrets?: string[];
  hooks?: RunHooks;
}

/** Everything one supervisor needs for one run. Owns state persistence and phase transitions. */
export class Run {
  readonly events: EventLog;
  readonly redactor: Redactor;
  readonly judge: FailOpenJudge;
  readonly childEnv: Record<string, string>;
  readonly tmpDir: string;
  readonly models: { planner: ResolvedModel; worker: ResolvedModel; cheap: ResolvedModel };
  readonly abort = new AbortController();
  /** Supervisor start, for elapsed-time accounting together with state.activeMs. */
  readonly startedAt: number;
  plan: Plan | undefined;
  /** True while the agent loop is blocked on a pause request (shown by the heartbeat). */
  paused = false;
  /** Where commands run. The supervisor swaps in the docker sandbox when sandbox = "docker". */
  exec: Executor = runShell;
  private readonly baseActiveMs: number;
  /** Waiting time that doesn't count as active (daily-cap pauses). */
  private excludedMs = 0;

  private constructor(
    readonly deps: RunDeps,
    readonly store: RunStore,
    public state: RunState,
  ) {
    this.startedAt = deps.clock.now();
    this.baseActiveMs = state.activeMs;
    this.redactor = Redactor.fromEnv(deps.env, deps.secrets ?? []);
    this.events = new EventLog(store.eventsPath, state.runId, this.redactor, deps.clock);
    this.events.cycle = state.cycle;
    this.tmpDir = join('/tmp', `omnexx-${state.runId}`);
    this.childEnv = scrubEnv(deps.env, {
      passthrough: deps.config.policy.env_passthrough,
      set: { TMPDIR: this.tmpDir },
    });
    const c = deps.config;
    this.models = {
      planner: resolveModel(c.models.planner, c),
      worker: resolveModel(c.models.worker, c),
      cheap: resolveModel(c.models.cheap, c),
    };
    this.judge = createJudge({
      config: c,
      clock: deps.clock,
      events: this.events,
      redactor: this.redactor,
      fetch: deps.fetch,
      llm: () =>
        new LlmJudge({
          provider: deps.provider,
          model: this.models.cheap,
          clock: deps.clock,
          beforeCall: (input, out) =>
            preflight(c.budget, {
              spentUsd: this.state.spend.usd,
              cycle: { turns: 0, tokens: 0 },
              estimatedInputTokens: input,
              maxOutputTokens: out,
              price: this.models.cheap.price,
            }).ok,
          afterCall: (res) => {
            void this.addSpend(
              res.usage,
              costUsd(res.usage, this.models.cheap.price),
              res.model,
              'judge',
            );
          },
        }),
    });
  }

  static async open(deps: RunDeps, runId: string): Promise<Run> {
    const store = new RunStore(deps.paths, runId);
    const state = await store.readState();
    const run = new Run(deps, store, state);
    run.plan = await store.readPlan();
    await mkdir(run.tmpDir, { recursive: true, mode: 0o700 });
    return run;
  }

  get config(): OmnexxConfig {
    return this.deps.config;
  }
  get clock(): Clock {
    return this.deps.clock;
  }
  get worktree(): string {
    return this.state.worktree;
  }

  policy(): PolicyContext {
    return {
      root: this.state.worktree,
      home: this.deps.env.HOME ?? '/nonexistent',
      allowNetwork: this.config.policy.allow_network,
      extraDeny: this.config.policy.deny,
      scratch: [this.tmpDir, `/private${this.tmpDir}`],
    };
  }

  get maxCmdTimeoutMs(): number {
    return parseDuration(this.config.budget.max_cmd_timeout);
  }

  /** Wall-clock the run has been active, across supervisor restarts. */
  elapsedMs(): number {
    return this.baseActiveMs + (this.clock.now() - this.startedAt) - this.excludedMs;
  }

  requirePlan(): Plan {
    if (!this.plan) throw new StateError(`run ${this.state.runId} has no plan yet`);
    return this.plan;
  }

  async save(): Promise<void> {
    this.state.updatedAt = this.clock.now();
    this.state.activeMs = this.elapsedMs();
    await this.store.writeState(this.state);
  }

  async savePlan(): Promise<void> {
    if (this.plan) await this.store.writePlan(this.plan);
  }

  /** Persist the transition first, then announce it; side effects of `phase` happen after. */
  async setPhase(phase: Phase, extra: Partial<RunState> = {}): Promise<void> {
    Object.assign(this.state, extra, { phase });
    await this.save();
    this.events.cycle = this.state.cycle;
    this.events.emit('phase', { phase, task: this.state.taskId });
    await this.deps.hooks?.onPhase?.(phase, this.state.cycle);
  }

  async control(): Promise<ControlSignal> {
    const c = await this.store.readControl();
    if (!c || c.request === 'resume') return 'continue';
    return c.request === 'pause' ? 'pause' : c.request;
  }

  /** Don't count `ms` of waiting towards max_hours. */
  excludeFromActive(ms: number): void {
    this.excludedMs += ms;
  }

  /** Spend in the rolling 24 h window. */
  spentToday(): number {
    return spentInWindow(this.state.spendLedger, this.clock.now());
  }

  async addSpend(usage: Usage, usd: number, model: string, role = 'worker'): Promise<void> {
    const s = this.state.spend;
    s.usd += usd;
    s.llmCalls++;
    if (role === 'worker' || role === 'planner') s.turns++;
    s.tokens.uncached += usage.uncached;
    s.tokens.cacheWrite += usage.cacheWrite5m + usage.cacheWrite1h;
    s.tokens.cacheRead += usage.cacheRead;
    s.tokens.output += usage.output;
    const key = `${role}:${model}`;
    s.byModel[key] = (s.byModel[key] ?? 0) + usd;
    const now = this.clock.now();
    this.state.spendLedger = [
      ...this.state.spendLedger.filter((e) => e.at > now - 25 * 3_600_000),
      { at: now, usd },
    ];
    await this.save();
  }
}
