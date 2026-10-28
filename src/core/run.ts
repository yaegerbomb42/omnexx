import type { WorkerPrefix } from '../verify/review.js';
import {
  callOrder,
  orderForStrategy,
  skipsOutModels,
  strategyFor,
  type Strategy,
} from '../config/routing.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDuration } from '../config/duration.js';
import type { OmnexxConfig } from '../config/schema.js';
import { ProviderError, StateError } from '../errors.js';
import { createJudge } from '../judge/factory.js';
import type { FailOpenJudge } from '../judge/fail-open.js';
import { LlmJudge } from '../judge/llm.js';
import { preflight, spentInWindow } from '../guard/budget.js';
import { TaskGovernor, type TaskCapKind } from '../guard/task-governor.js';
import { costUsd, resolveChain, type ResolvedModel } from '../providers/pricing.js';
import { shouldFailover } from '../providers/router.js';
import { QuotaLedger } from '../providers/quota-ledger.js';
import { isQuotaError } from '../providers/sticky.js';
import {
  UsageLedger,
  purposeForRole,
  type CallMeta,
  type CallPurpose,
} from '../providers/usage-ledger.js';
import {
  type CompletionRequest,
  type CompletionResponse,
  type Provider,
  type Usage,
} from '../providers/types.js';
import { scrubEnv } from '../security/env-scrub.js';
import type { PolicyContext } from '../security/command-policy.js';
import { Redactor } from '../security/redact.js';
import { ModelRouter } from '../router/router.js';
import type { ControlSignal } from '../agent/loop.js';
import type { Clock } from './clock.js';
import { EventLog } from './events.js';
import { runShell, type Executor } from './exec.js';
import { usageFile, type OmnexxPaths } from './paths.js';
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
/** Even at the very end of a run, a command gets this long. */
const MIN_CMD_TIMEOUT_MS = 30_000;

export class Run {
  readonly events: EventLog;
  readonly redactor: Redactor;
  readonly judge: FailOpenJudge;
  readonly router: ModelRouter;
  readonly childEnv: Record<string, string>;
  readonly tmpDir: string;
  /** First model of each role's chain (single-shot helpers use these). */
  readonly models: { planner: ResolvedModel; worker: ResolvedModel; cheap: ResolvedModel };
  /** Each role's failover chain, in order. */
  readonly chains: { planner: ResolvedModel[]; worker: ResolvedModel[]; cheap: ResolvedModel[] };
  /** Models that failed at planning this run ("provider:id"); the planner falls back past them. */
  readonly plannerFailed = new Set<string>();
  /** Providers that just failed: skipped until the timestamp. */
  private readonly cooling = new Map<string, number>();
  readonly abort = new AbortController();
  /** Aborts only the current cycle (the stall watchdog), unlike `abort` which ends the run. */
  private cycleAbort = new AbortController();
  /**
   * Cached `AbortSignal.any` of run + cycle. Recreating it on every `signal` read would add a
   * listener to `abort` per call and leak them until the run ends.
   */
  private combinedSignal: AbortSignal = AbortSignal.any([
    this.abort.signal,
    this.cycleAbort.signal,
  ]);
  /** Serialize state.json writes so overlapping save() calls cannot persist a stale snapshot. */
  private saveChain: Promise<void> = Promise.resolve();
  /** Set by the watchdog when it aborted the current cycle for silence: what it saw. */
  hang: string | undefined;
  /** Supervisor start, for elapsed-time accounting together with state.activeMs. */
  /** What every model call and command of the current cycle listens to. */
  get signal(): AbortSignal {
    return this.combinedSignal;
  }

  /** A fresh cycle: a new abort switch, and no hang or deadline recorded. */
  newCycle(): void {
    this.cycleAbort = new AbortController();
    this.hang = undefined;
    this.deadlineHit = false;
    this.combinedSignal = AbortSignal.any([this.abort.signal, this.cycleAbort.signal]);
  }

  /** The watchdog's way out of a hung cycle: abort it, keep the run. */
  abortCycle(reason: string): void {
    if (this.cycleAbort.signal.aborted) return;
    this.hang = reason;
    this.cycleAbort.abort(new Error(reason));
  }

  /**
   * max_hours passed inside a cycle: end it now. Unlike a hang its partial work is verified as
   * usual (kept if the gates pass), and the run stops at the next cycle boundary.
   */
  endCycleAtDeadline(): void {
    if (this.cycleAbort.signal.aborted) return;
    this.deadlineHit = true;
    this.cycleAbort.abort(new Error('max_hours reached'));
  }

  /** Whether this cycle was ended by `endCycleAtDeadline`. */
  deadlineHit = false;
  /**
   * System blocks and messages of the latest worker turn. Review and audit append one user
   * message so the cached prefix is reused. Not persisted.
   */
  workerPrefix: WorkerPrefix | undefined = undefined;

  /** max_hours in ms. */
  get deadlineMs(): number {
    return this.config.budget.max_hours * 3_600_000;
  }

  readonly startedAt: number;
  plan: Plan | undefined;
  /** True while the agent loop is blocked on a pause request (shown by the heartbeat). */
  paused = false;
  /**
   * Set by the supervisor's idle watchdog when no event has arrived for `idleTimeoutMs`.
   * The next cycle boundary ends the run as needs-human; a pause loop does not reset it.
   */
  idleTimedOut = false;
  /** Where commands run. The supervisor swaps in the docker sandbox when sandbox = "docker". */
  exec: Executor = runShell;
  private readonly baseActiveMs: number;
  /** Waiting time that doesn't count as active (daily-cap pauses). */
  private excludedMs = 0;
  /** Per-cycle accumulators for the time.report event (reset at cycle start). */
  cycleModelMs = 0;
  cycleToolMs = 0;
  lastCycleModelMs = 0;
  lastCycleToolMs = 0;

  private constructor(
    readonly deps: RunDeps,
    readonly store: RunStore,
    public state: RunState,
  ) {
    this.startedAt = deps.clock.now();
    this.baseActiveMs = state.activeMs;
    this.quota = new QuotaLedger(join(deps.paths.configHome, 'quota.json'), () => deps.clock.now());
    this.redactor = Redactor.fromEnv(deps.env, deps.secrets ?? []);
    this.usage = new UsageLedger(
      usageFile(deps.paths),
      state.runId,
      deps.env.OMNEXX_TASK_LABEL ?? state.runId,
      () => deps.clock.now(),
    );
    this.taskBudget = new TaskGovernor(
      {
        maxTokens: deps.config.budget.task_max_tokens,
        maxUsd: deps.config.budget.task_max_usd,
        warnAt: deps.config.budget.warn_at,
      },
      () => deps.clock.now(),
    );
    this.events = new EventLog(store.eventsPath, state.runId, this.redactor, deps.clock);
    // Waste is derived from events that already know the tool/compaction outcome: no extra
    // bookkeeping in the loop, and every run (even one interrupted mid-call) leaves a trail.
    this.events.onEvent((e) => {
      if (e.type === 'read.dedup') {
        this.usage.recordReadSaved({
          ...(typeof e.task === 'string' ? { taskId: e.task } : {}),
          cycle: typeof e.cycle === 'number' ? e.cycle : undefined,
          ...(typeof e.turn === 'number' ? { turn: e.turn } : {}),
          tokens: typeof e.savedTokens === 'number' ? e.savedTokens : 0,
          ...(typeof e.path === 'string' ? { path: e.path } : {}),
          ...(typeof e.fromStep === 'number' ? { fromStep: e.fromStep } : {}),
        });
      } else if (e.type === 'provider.retry') {
        const tokens = typeof e.estimatedInputTokens === 'number' ? e.estimatedInputTokens : 0;
        // A failed attempt is still a model call: record it (zero billed usage) so the ledger has
        // no unattributed attempt, then coalesce the repeated ones as waste.
        this.usage.recordCall(
          {
            purpose: 'retry',
            ...(state.taskId ? { taskId: state.taskId } : {}),
            cycle: state.cycle,
            turn: typeof e.turn === 'number' ? e.turn : 0,
            step: `c${String(state.cycle)}.retry`,
            attempt: typeof e.attempt === 'number' ? e.attempt : 1,
            promptTokens: tokens,
          },
          {
            model: typeof e.model === 'string' ? e.model : 'unknown',
            provider: typeof e.provider === 'string' ? e.provider : 'unknown',
            usage: { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
            usd: 0,
          },
        );
        this.usage.recordRetry({
          signature: typeof e.error === 'string' ? e.error : 'unknown error',
          tokens,
          ...(state.taskId ? { taskId: state.taskId } : {}),
          cycle: state.cycle,
          turn: typeof e.turn === 'number' ? e.turn : undefined,
        });
      } else if (e.type === 'context.compacted') {
        this.usage.recordCompaction({
          before: typeof e.tokensBefore === 'number' ? e.tokensBefore : 0,
          after: typeof e.tokensAfter === 'number' ? e.tokensAfter : 0,
          ...(state.taskId ? { taskId: state.taskId } : {}),
          cycle: state.cycle,
        });
      } else if (e.type === 'context.compact_failed') {
        const tokens = typeof e.tokens === 'number' ? e.tokens : 0;
        this.usage.recordCompaction({
          before: tokens,
          after: tokens,
          ...(state.taskId ? { taskId: state.taskId } : {}),
          cycle: state.cycle,
          detail: typeof e.reason === 'string' ? e.reason : 'summary failed',
        });
      }
    });
    this.events.cycle = state.cycle;
    this.tmpDir = join('/tmp', `omnexx-${state.runId}`);
    this.childEnv = scrubEnv(deps.env, {
      passthrough: deps.config.policy.env_passthrough,
      set: { TMPDIR: this.tmpDir },
    });
    const c = deps.config;
    // Each role's routing strategy orders its chain once per run (random, smart); least-busy
    // only matters for parallel helpers, which order their chain per start.
    const routed = (role: 'planner' | 'worker' | 'cheap') =>
      orderForStrategy(resolveChain(c.models[role], c), strategyFor(c.models, role));
    this.chains = { planner: routed('planner'), worker: routed('worker'), cheap: routed('cheap') };
    const first = (chain: ResolvedModel[]): ResolvedModel => {
      const m = chain[0];
      if (!m) throw new StateError('empty model chain');
      return m;
    };
    this.models = {
      planner: first(this.chains.planner),
      worker: first(this.chains.worker),
      cheap: first(this.chains.cheap),
    };
    this.judge = createJudge({
      config: c,
      clock: deps.clock,
      events: this.events,
      redactor: this.redactor,
      fetch: deps.fetch,
      llm: () =>
        new LlmJudge({
          clock: deps.clock,
          complete: (req, estimate, maxOut) =>
            this.cheapComplete(req, {
              estimatedInputTokens: estimate,
              maxOutputTokens: maxOut,
              role: 'judge',
              purpose: 'judge',
            }),
        }),
    });
    this.router = new ModelRouter({
      config: c,
      judge: this.judge,
      roleChains: this.chains,
      events: this.events,
      now: () => deps.clock.now(),
      modelExhausted: (r) => this.modelExhausted(r),
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

  /**
   * The command timeout, but never past the run's wall-clock cap (plus a minute to wrap up): a
   * hanging test suite must not hold a run far beyond --hours, where nothing can stop it.
   */
  get maxCmdTimeoutMs(): number {
    const cap = parseDuration(this.config.budget.max_cmd_timeout);
    const left = this.config.budget.max_hours * 3_600_000 - this.elapsedMs() + 60_000;
    return Math.max(MIN_CMD_TIMEOUT_MS, Math.min(cap, left));
  }

  /** Wall-clock the run has been active, across supervisor restarts. */
  elapsedMs(): number {
    return this.baseActiveMs + (this.clock.now() - this.startedAt) - this.excludedMs;
  }

  requirePlan(): Plan {
    if (!this.plan) throw new StateError(`run ${this.state.runId} has no plan yet`);
    return this.plan;
  }

  /**
   * Park the current task at a cap: write a resumable checkpoint (plan node, transcript tail,
   * task and run spend), mark the state, and tell the feed before the supervisor stops. Doing
   * this here keeps both the main loop and cheap calls (a review or fold that crossed the cap)
   * on the same path.
   */
  async parkAtTaskCap(kind: TaskCapKind, detail?: string): Promise<string> {
    const taskId = this.state.taskId ?? 'run';
    const snapshot = this.taskBudget.snapshot(taskId);
    const node = this.plan?.nodes.find((n) => n.id === taskId);
    const checkpoint = await this.store.writeTaskCheckpoint(
      `task-${taskId}-c${String(this.state.cycle)}`,
      this.redactor.value({
        kind: 'task-park',
        runId: this.state.runId,
        taskId,
        title: node?.title,
        cycle: this.state.cycle,
        at: this.clock.now(),
        cap: kind,
        taskSpend: snapshot,
        runSpend: this.state.spend,
        act: this.state.act,
        messages: this.workerPrefix?.messages ?? [],
        plan: node ?? null,
      }),
    );
    this.state.taskCapHit = {
      taskId,
      kind,
      cycle: this.state.cycle,
      at: this.clock.now(),
      usd: snapshot.usd,
      tokens: snapshot.tokens,
      detail:
        detail ??
        `task parked at ${kind} (${snapshot.fraction === undefined ? 'cap reached' : `${String(Math.round(snapshot.fraction * 100))}%`})`,
      checkpoint,
    };
    await this.save();
    this.events.emit('budget.task_park', {
      task: taskId,
      kind,
      tokens: snapshot.tokens,
      usd: snapshot.usd,
      checkpoint,
    });
    return checkpoint;
  }

  async save(): Promise<void> {
    const next = this.saveChain.then(() => this.persistState());
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  private async persistState(): Promise<void> {
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

  /** Why this provider can't take a call right now (its own caps, or cooling after a failure). */
  providerBlocked(provider: string): string | undefined {
    const until = this.cooling.get(provider) ?? 0;
    if (until > this.clock.now())
      return `cooling down after a failure until ${new Date(until).toISOString()}`;
    const cfg =
      provider === 'anthropic'
        ? this.config.providers.anthropic
        : this.config.providers.endpoints[provider];
    const spent = this.state.spend.byProvider[provider] ?? 0;
    if (cfg?.max_usd !== undefined && spent >= cfg.max_usd)
      return `provider max_usd reached (${spent.toFixed(2)} of ${cfg.max_usd})`;
    if (cfg?.max_usd_per_day !== undefined) {
      const now = this.clock.now();
      const day = this.state.spendLedger
        .filter((e) => e.provider === provider && e.at > now - 86_400_000)
        .reduce((s, e) => s + e.usd, 0);
      if (day >= cfg.max_usd_per_day)
        return `provider max_usd_per_day reached (${day.toFixed(2)} of ${cfg.max_usd_per_day})`;
    }
    return undefined;
  }

  /** Models out of quota, shared with every other run and chat on this machine. */
  readonly quota: QuotaLedger;
  /** Append-only attribution of every billed call, shared by every run on this machine. */
  readonly usage: UsageLedger;
  /** Per-task token/dollar caps (off unless budget.task_max_* is set). */
  readonly taskBudget: TaskGovernor;

  modelExhausted(ref: string): boolean {
    return this.quota.isOut(ref);
  }

  /** A fallback list stays off a rate-limited model for `ms`, in every session. */
  markRateLimited(ref: string, ms: number): void {
    this.quota.mark(ref, ms);
  }

  /** How a role's chain is used per call (see routing.ts). */
  strategy(role: string): Strategy {
    return strategyFor(this.config.models, role);
  }

  markExhausted(ref: string): void {
    this.quota.mark(ref);
    this.events.emit('provider.quota_exhausted', { model: ref });
  }

  coolProvider(provider: string, ms: number): void {
    this.cooling.set(provider, this.clock.now() + ms);
  }

  /** The smaller of the money and time budgets still left, 0..1 (the router weighs this). */
  budgetLeftFraction(): number {
    const b = this.config.budget;
    const usd = 1 - this.state.spend.usd / b.max_usd;
    const hours = 1 - this.state.activeMs / (b.max_hours * 3_600_000);
    return Math.max(0, Math.min(1, usd, hours));
  }

  /**
   * One side call on the cheap chain (judge, summaries, codemap, compaction): tried in order like
   * a worker turn, skipping blocked providers, pre-flighted against each model's own price, and
   * routed to that model's provider. Returns undefined when the budget refuses the call; throws
   * when every provider failed.
   */
  async cheapComplete(
    req: Omit<CompletionRequest, 'model' | 'route'>,
    opts: {
      estimatedInputTokens: number;
      maxOutputTokens: number;
      role: string;
      /** What this call was for; defaults from `role` so no call can be untagged. */
      purpose?: CallPurpose;
      /** Which role's chain to try: the cheap one (default), or the worker's / planner's. */
      chain?: 'cheap' | 'worker' | 'planner';
    },
  ): Promise<{ res: CompletionResponse; model: ResolvedModel } | undefined> {
    const errors: string[] = [];
    const strategy = this.strategy(opts.chain ?? 'cheap');
    const purpose = opts.purpose ?? purposeForRole(opts.role);
    for (const model of callOrder(this.chains[opts.chain ?? 'cheap'], strategy)) {
      if (skipsOutModels(strategy) && this.modelExhausted(`${model.provider}:${model.id}`)) {
        errors.push(`${model.provider}:${model.id}: out of quota`);
        continue;
      }
      const blocked = this.providerBlocked(model.provider);
      if (blocked) {
        errors.push(`${model.provider}: ${blocked}`);
        continue;
      }
      const pf = preflight(this.config.budget, {
        spentUsd: this.state.spend.usd,
        spentTodayUsd: this.spentToday(),
        cycle: { turns: 0, tokens: 0 },
        estimatedInputTokens: opts.estimatedInputTokens,
        maxOutputTokens: opts.maxOutputTokens,
        price: model.price,
      });
      if (!pf.ok) return undefined;
      const tb =
        this.state.taskId && purpose !== 'planning'
          ? this.taskBudget.check({
              taskId: this.state.taskId,
              promptTokens: opts.estimatedInputTokens,
              maxOutputTokens: opts.maxOutputTokens,
              price: model.price,
            })
          : undefined;
      if (tb && !tb.allowed) {
        await this.parkAtTaskCap(tb.kind ?? 'task_max_tokens', tb.detail);
        return undefined;
      }
      if (tb?.warning)
        this.events.emit('budget.task_warn', {
          task: this.state.taskId,
          cap: tb.warning.cap,
          fraction: tb.warning.fraction,
          cycle: this.state.cycle,
        });
      try {
        const res = await this.deps.provider.complete({
          ...req,
          model: model.id,
          route: model.provider,
        });
        await this.addSpend(
          res.usage,
          costUsd(res.usage, model.price),
          res.model,
          opts.role,
          model.provider,
          {
            purpose,
            ...(this.state.taskId ? { taskId: this.state.taskId } : {}),
            cycle: this.state.cycle,
            turn: 0,
            step: `c${String(this.state.cycle)}.${opts.role}`,
            promptTokens: opts.estimatedInputTokens,
          },
        );
        return { res, model };
      } catch (err) {
        if (!shouldFailover(err)) throw err;
        if (isQuotaError(err)) this.markExhausted(`${model.provider}:${model.id}`);
        else if (!err.contentFilter)
          this.coolProvider(model.provider, err.retryable ? 60_000 : 30 * 60_000);
        this.events.emit('provider.failover', {
          provider: model.provider,
          model: model.id,
          error: err.message,
          status: err.status,
          role: opts.role,
        });
        errors.push(`${model.provider}: ${err.message}`);
      }
    }
    throw new ProviderError(`no cheap model could take the call: ${errors.join('; ')}`, {
      retryable: true,
    });
  }

  async addSpend(
    usage: Usage,
    usd: number,
    model: string,
    role = 'worker',
    provider = 'anthropic',
    meta: CallMeta = { purpose: purposeForRole(role) },
  ): Promise<void> {
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
    s.byProvider[provider] = (s.byProvider[provider] ?? 0) + usd;
    const now = this.clock.now();
    this.state.spendLedger = [
      ...this.state.spendLedger.filter((e) => e.at > now - 25 * 3_600_000),
      { at: now, usd, provider },
    ];
    // Planning runs between tasks: never bill it to the task that just finished.
    const taskId = meta.taskId ?? (meta.purpose === 'planning' ? undefined : this.state.taskId);
    this.usage.recordCall(
      { ...meta, ...(taskId ? { taskId } : {}) },
      { model, provider, usage, usd, ...(taskId ? { taskId } : {}) },
    );
    const observed = this.taskBudget.observe({
      taskId: taskId ?? (meta.purpose === 'planning' ? 'run' : (this.state.taskId ?? 'run')),
      tokens:
        usage.uncached + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead + usage.output,
      usd,
    });
    if (observed.warning) {
      const warningKey = this.taskBudget.warningKey(observed.snapshot, observed.warning.cap);
      if (!this.state.warned.includes(warningKey)) {
        this.state.warned.push(warningKey);
        this.events.emit('budget.task_warn', {
          task: taskId,
          cap: observed.warning.cap,
          fraction: observed.warning.fraction,
          tokens: observed.snapshot.tokens,
          usd: observed.snapshot.usd,
        });
      }
    }
    await this.save();
  }
}
