import { PlannerIncomplete, runPlanner } from '../agent/planner.js';
import { join } from 'node:path';
import { EXIT } from '../cli/exit-codes.js';
import { DockerSandbox } from '../security/sandbox-docker.js';
import { readBootId } from '../daemon/boot-id.js';
import { LockError } from '../errors.js';
import {
  dailyPauseThreshold,
  inWrapup,
  runLimitHit,
  shouldWarn,
  windowRollsAt,
} from '../guard/budget.js';
import { climb, escalateModel, LADDER, park } from '../guard/ladder.js';
import { taskStuckSignals, type StuckFinding } from '../guard/stuck.js';
import { decideNextMove } from '../judge/next-move.js';
import type { AgentStateSummary } from '../judge/state-summary.js';
import type { NextMove } from '../judge/uses.js';
import { nullNotifier, NtfyNotifier, type Notifier, type NotifyKind } from '../notify/ntfy.js';
import { runGates } from '../verify/gates.js';
import { judgeGate } from '../verify/ratchet.js';
import {
  prepareWorktree,
  runBaseline,
  stepAct,
  stepCommit,
  stepRecord,
  stepRollback,
  stepVerify,
} from './cycle.js';
import { startHeartbeat } from './heartbeat.js';
import { acquireLock, defaultLockEnv, releaseLock, type LockEnv } from './lock.js';
import { initCodemap, settleMilestones } from './milestones.js';
import { childrenOf, getNode, nextUnexpandedMilestone, planCounts, runnableTasks } from './plan.js';
import { writeReport } from './report.js';
import type { RunStatus } from './run-store.js';
import { Run, type RunDeps } from './run.js';

export interface SuperviseOptions {
  bootId?: string;
  lockEnv?: Partial<LockEnv>;
  heartbeatMs?: number;
  controlPollMs?: number;
  pausePollMs?: number;
  notifier?: Notifier;
}

export interface Outcome {
  status: RunStatus;
  reason: string;
}

export const EXIT_FOR: Record<RunStatus, number> = {
  finished: EXIT.ok,
  planned: EXIT.ok,
  'needs-human': EXIT.needsHuman,
  'budget-stop': EXIT.budgetStop,
  'user-stop': EXIT.userStop,
  running: EXIT.error,
  paused: EXIT.error,
  error: EXIT.error,
};

const MAX_MILESTONE_REPLANS = 2;

class Supervisor {
  constructor(
    private readonly run: Run,
    private readonly notifier: Notifier,
    private readonly opts: SuperviseOptions,
  ) {}

  private notify(
    kind: NotifyKind,
    extra: { taskTitle?: string; hint?: string } = {},
  ): Promise<void> {
    const r = this.run;
    const c = r.plan ? planCounts(r.plan) : undefined;
    return this.notifier.notify({
      kind,
      runId: r.state.runId,
      repo: r.state.repoName,
      status: r.state.status,
      ...(c ? { done: c.done, total: c.tasks, parked: c.parked } : {}),
      commits: r.state.acceptedCommits,
      usd: r.state.spend.usd,
      budgetUsd: r.config.budget.max_usd,
      ...extra,
    });
  }

  /** Finish an in-flight cycle after a crash, from exactly the persisted phase. */
  private async resumeInFlight(): Promise<void> {
    const r = this.run;
    switch (r.state.phase) {
      case 'act':
        r.events.emit('reconcile.restart_act', { cycle: r.state.cycle, task: r.state.taskId });
        await stepAct(r); // prepareWorktree salvages a dirty tree; attempts are not incremented
        await stepVerify(r);
        await this.finishCycle();
        return;
      case 'verify':
        await stepVerify(r);
        await this.finishCycle();
        return;
      case 'commit':
      case 'rollback':
        await this.finishCycle();
        return;
      case 'record':
        await stepRecord(r);
        await this.guardPost();
        return;
      case 'guard':
        await this.guardPost();
        return;
      default:
        if (r.plan) await prepareWorktree(r);
    }
  }

  private async finishCycle(): Promise<void> {
    const r = this.run;
    if (r.state.phase === 'commit') await stepCommit(r);
    else if (r.state.phase === 'rollback') await stepRollback(r);
    await stepRecord(r);
    await this.guardPost();
  }

  private async cycle(taskId: string): Promise<void> {
    const r = this.run;
    r.state.cycle++;
    await r.setPhase('act', { taskId, pending: undefined, act: undefined });
    r.events.emit('cycle.start', { task: taskId });
    await stepAct(r);
    await stepVerify(r);
    await this.finishCycle();
  }

  /** GUARD after RECORD: stuck signals → ladder; the judge's advisory next move; then SELECT. */
  private async guardPost(): Promise<void> {
    const r = this.run;
    const p = r.state.pending;
    const plan = r.requirePlan();
    if (p) {
      let task = getNode(plan, p.taskId);
      const findings: StuckFinding[] = taskStuckSignals(task, r.config.stuck);
      if (p.stuck.includes('oscillation'))
        findings.push({ signal: 'oscillation', detail: 'diff reverted earlier accepted work' });
      for (const f of findings)
        if (f.signal !== 'oscillation')
          r.events.emit('stuck.signal', { signal: f.signal, task: task.id, detail: f.detail });
      if (p.stuck.includes('judge_drift'))
        r.events.emit('stuck.secondary', { signal: 'judge_drift', task: task.id });

      let rule: NextMove = 'continue';
      let allowed = new Set<NextMove>(['continue']);
      // Climb on a rejection, or when accepted partial progress has stopped converging.
      if (task.status !== 'done' && (p.verdict === 'reject' || findings.length > 0)) {
        const climbed = findings.length ? climb(task, findings) : undefined;
        if (climbed)
          r.events.emit('ladder.rung', {
            task: task.id,
            rung: climbed.rung.id,
            detail: climbed.detail,
          });
        if (climbed?.rung.id === 'replan_task') {
          const split = await this.splitTask(task.id, findings.map((f) => f.detail).join('; '));
          task = getNode(r.requirePlan(), p.taskId);
          if (!split) {
            r.events.emit('ladder.rung', {
              task: task.id,
              rung: 'park',
              detail: park.apply(task, findings),
              fallback: 'split produced no tasks',
            });
            task.rung = LADDER.indexOf(park);
          }
        }
        if (task.status === 'parked') {
          rule = task.splitInto.length ? 'split_task' : 'park_and_move_on';
          allowed = new Set([rule]);
          r.events.emit('task.parked', { task: task.id, reason: task.parkedReason });
        } else {
          rule =
            climbed?.rung.id === 'escalate_model'
              ? 'switch_to_strong_model'
              : 'retry_different_approach';
          allowed = new Set<NextMove>([
            'retry_different_approach',
            'revert_to_last_green',
            'park_and_move_on',
            'switch_to_strong_model',
            'split_task',
          ]);
        }
      }
      const decision = await decideNextMove(
        r.judge,
        r.config.judge,
        this.summary(task.id),
        rule,
        allowed,
      );
      if (decision.pick !== undefined || decision.override === 'abstained')
        r.events.emit('judge.next_move', { task: task.id, ...decision });
      if (decision.final === 'park_and_move_on' && task.status !== 'parked') {
        task.status = 'parked';
        task.parkedReason = `judge (steer) suggested parking with p=${decision.probability?.toFixed(2) ?? '?'}`;
        r.events.emit('task.parked', { task: task.id, reason: task.parkedReason });
      } else if (decision.final === 'switch_to_strong_model' && !task.escalated) {
        r.events.emit('ladder.rung', {
          task: task.id,
          rung: 'escalate_model',
          detail: escalateModel.apply(task, []),
          source: 'judge',
        });
      } else if (decision.final === 'split_task' && !task.splitInto.length) {
        r.events.emit('ladder.rung', {
          task: task.id,
          rung: 'replan_task',
          detail: 'split requested',
          source: 'judge',
        });
        await this.splitTask(task.id, 'the judge suggested splitting it');
      } else if (decision.final === 'retry_different_approach' && decision.final !== rule) {
        task.evidence = [
          ...task.evidence,
          'Try a substantially different approach from the ones already tried.',
        ].slice(-3);
      }
      await r.savePlan();
    }
    await r.setPhase('select', { pending: undefined });
  }

  /**
   * Ladder rung 3: the planner splits a stuck task into smaller tasks under the same milestone.
   * The original is parked with `splitInto`; anything that depended on it now depends on the
   * new tasks; it becomes done once they all are. Returns false when no new task came out.
   */
  private async splitTask(taskId: string, reason: string): Promise<boolean> {
    const r = this.run;
    await r.savePlan();
    const before = new Set(r.requirePlan().nodes.map((n) => n.id));
    const parentId = getNode(r.requirePlan(), taskId).parentId;
    try {
      await runPlanner(r, { kind: 'split', taskId, reason });
    } catch (err) {
      if (!(err instanceof PlannerIncomplete)) throw err;
      r.events.emit('planner.incomplete', { end: err.end, mode: 'split' });
      return false;
    }
    const plan = r.requirePlan();
    const fresh = plan.nodes
      .filter((n) => n.type === 'task' && n.parentId === parentId && !before.has(n.id))
      .map((n) => n.id);
    if (!fresh.length) return false;
    const task = getNode(plan, taskId);
    task.splitInto = fresh;
    task.status = 'parked';
    task.parkedReason = `split into ${fresh.join(', ')}`;
    for (const n of plan.nodes) {
      if (n.dependsOn.includes(taskId) && !fresh.includes(n.id)) {
        n.dependsOn = [...n.dependsOn.filter((d) => d !== taskId), ...fresh];
      }
    }
    await r.savePlan();
    r.events.emit('task.split', { task: taskId, into: fresh });
    return true;
  }

  /** A split task is done when every task it was split into is done. */
  private async settleSplits(): Promise<void> {
    const r = this.run;
    const plan = r.requirePlan();
    let changed = false;
    for (const n of plan.nodes) {
      if (
        n.status === 'parked' &&
        n.splitInto.length &&
        n.splitInto.every((id) => getNode(plan, id).status === 'done')
      ) {
        n.status = 'done';
        n.doneAtCycle = r.state.cycle;
        n.parkedReason = undefined;
        r.events.emit('task.done', { task: n.id, via: 'split' });
        changed = true;
      }
    }
    if (changed) await r.savePlan();
  }

  /**
   * Rolling daily cap (plan §3.11): at 90% of `max_usd_per_day` in the last 24 h the run pauses
   * until enough spend has rolled out of the window, then resumes on its own. A stop request
   * still ends it.
   */
  private async dailyCapPause(): Promise<Outcome | undefined> {
    const r = this.run;
    const threshold = dailyPauseThreshold(r.config.budget);
    const today = r.spentToday();
    if (today < threshold && !r.state.dailyCapHit) return undefined;
    // Wait until at least half the cap is free again, so the next calls fit.
    const until = windowRollsAt(
      r.state.spendLedger,
      r.clock.now(),
      r.config.budget.max_usd_per_day * 0.5,
    );
    r.state.status = 'paused';
    r.state.statusReason = `daily cap: ${today.toFixed(2)} of ${r.config.budget.max_usd_per_day} in 24 h; resumes at ${new Date(until).toISOString()}`;
    await r.save();
    r.events.emit('budget.daily_pause', {
      spentToday: today,
      cap: r.config.budget.max_usd_per_day,
      until,
    });
    await this.notify('budget', { hint: r.state.statusReason });
    const pausedAt = r.clock.now();
    while (r.clock.now() < until) {
      const c = await r.control();
      if (c === 'stop' || c === 'stop-now')
        return { status: 'user-stop', reason: 'stopped during the daily-cap pause' };
      await r.clock.sleep(Math.min(60_000, until - r.clock.now()));
    }
    r.excludeFromActive(r.clock.now() - pausedAt);
    r.state.dailyCapHit = false;
    r.state.lastProgressAt = r.clock.now();
    r.state.status = 'running';
    r.state.statusReason = undefined;
    await r.save();
    r.events.emit('budget.daily_resume', { spentToday: r.spentToday() });
    return undefined;
  }

  private summary(taskId: string): AgentStateSummary {
    const r = this.run;
    const t = getNode(r.requirePlan(), taskId);
    const p = r.state.pending;
    const b = r.config.budget;
    return {
      goal: r.plan?.goal ?? '',
      task: { id: t.id, title: t.title, acceptance: t.acceptance, attempts: t.attempts },
      lastResult: {
        outcome: p ? (p.verdict === 'accept' ? 'accepted' : 'rejected') : 'none',
        passed: p?.testsPassed ?? 0,
        failed: p?.reasons.length ?? 0,
        topFailures: p?.reasons.slice(0, 5) ?? [],
      },
      recentSignatures: t.failureSignatures.slice(-5),
      diff: p?.diffStats ?? { files: 0, added: 0, removed: 0 },
      approachesTried: t.approachesTried,
      budgetLeft: {
        usd: Math.max(0, b.max_usd - r.state.spend.usd),
        cycles: Math.max(0, b.max_cycles - r.state.cycle),
        hours: Math.max(0, b.max_hours - r.elapsedMs() / 3_600_000),
      },
    };
  }

  /** Cycle-boundary guards. Returns a terminal outcome, or undefined to keep going. */
  private async guardPre(): Promise<Outcome | undefined> {
    const r = this.run;
    let c = await r.control();
    if (c === 'pause') {
      r.state.status = 'paused';
      await r.save();
      r.events.emit('control.paused', { at: 'cycle-boundary' });
      while (c === 'pause') {
        await r.clock.sleep(this.opts.pausePollMs ?? 1_000);
        c = await r.control();
      }
      r.state.status = 'running';
      await r.save();
      r.events.emit('control.resumed', {});
    }
    if (c === 'stop' || c === 'stop-now')
      return { status: 'user-stop', reason: 'stopped by request' };

    if (r.state.budgetExhausted) {
      r.events.emit('budget.stop', {
        kind: 'max_usd',
        detail: 'the next model call could exceed max_usd',
      });
      return {
        status: 'budget-stop',
        reason: `max_usd reached (${r.state.spend.usd.toFixed(2)} of ${r.config.budget.max_usd}; the next call could exceed it)`,
      };
    }
    const paused = await this.dailyCapPause();
    if (paused) return paused;
    const limits = { spentUsd: r.state.spend.usd, elapsedMs: r.elapsedMs(), cycles: r.state.cycle };
    const hit = runLimitHit(r.config.budget, limits);
    if (hit) {
      r.events.emit('budget.stop', { kind: hit.kind, detail: hit.detail });
      return { status: 'budget-stop', reason: `${hit.kind} reached (${hit.detail})` };
    }
    if (shouldWarn(r.config.budget, limits) && !r.state.warned.includes('budget')) {
      r.state.warned.push('budget');
      await r.save();
      r.events.emit('budget.warn', { ...limits, warnAt: r.config.budget.warn_at });
      await this.notify('budget', {
        hint: `${Math.round(r.config.budget.warn_at * 100)}% of the budget used`,
      });
    }
    if (inWrapup(r.config.budget, limits)) {
      await r.setPhase('wrapup');
      await this.finalVerify();
      return {
        status: 'budget-stop',
        reason: `wrap-up reserve reached (${Math.round(r.config.budget.wrapup_reserve * 100)}% of budget or time left)`,
      };
    }
    const goal = await r.store.readGoal();
    if (goal.hash !== r.state.goalHash) {
      r.events.emit('goal.changed', { from: r.state.goalHash, to: goal.hash });
      r.state.goalHash = goal.hash;
      if (r.plan) r.plan.goal = goal.text.trim();
      await r.save();
      await r.savePlan();
    }
    const sinceCycles = r.state.cycle - r.state.lastProgressCycle;
    const sinceMs = r.clock.now() - (r.state.lastProgressAt ?? r.state.startedAt);
    if (
      sinceCycles >= r.config.stuck.no_progress_cycles ||
      sinceMs >= r.config.stuck.no_progress_hours * 3_600_000
    ) {
      r.events.emit('stuck.signal', { signal: 'no_progress', cycles: sinceCycles, ms: sinceMs });
      return { status: 'needs-human', reason: `no accepted commit for ${sinceCycles} cycles` };
    }
    if (r.state.noChecks && r.state.cycle >= 1)
      return { status: 'finished', reason: 'single cycle (no checks configured)' };
    return undefined;
  }

  private async finalVerify(): Promise<void> {
    const r = this.run;
    await prepareWorktree(r);
    const results = await runGates(r.config.gates, {
      exec: r.exec,
      cwd: r.worktree,
      env: r.childEnv,
      logsDir: r.store.logsDir,
      label: 'final',
      maxCmdTimeoutMs: r.maxCmdTimeoutMs,
      redact: (s) => r.redactor.text(s),
      signal: r.abort.signal,
    });
    r.events.emit('final.verify', {
      gates: results.map((g) => ({
        gate: g.name,
        pass: judgeGate(g, r.state.baseline).pass,
        failures: g.failures.length,
      })),
    });
  }

  private async setup(): Promise<void> {
    const r = this.run;
    if (r.state.setupDone) return;
    for (const command of r.config.setup) {
      const res = await r.exec(command, {
        cwd: r.worktree,
        env: r.childEnv,
        timeoutMs: r.maxCmdTimeoutMs,
        logPath: `${r.store.logsDir}/setup.log`,
        redact: (s) => r.redactor.text(s),
      });
      r.events.emit('setup', { command, exitCode: res.exitCode });
      if (res.exitCode !== 0)
        throw new Error(
          `setup command failed: ${command} (exit ${res.exitCode}); see logs/setup.log`,
        );
    }
    r.state.setupDone = true;
    await r.save();
  }

  private async plan(): Promise<void> {
    const r = this.run;
    await r.setPhase('planning');
    await this.setup();
    await initCodemap(r);
    if (!r.state.baseline) await runBaseline(r);
    await runPlanner(r, { kind: 'initial' });
    await r.setPhase('select');
  }

  /** Milestones, rolling-wave expansion, and the end-of-plan decision. Returns a task id or an outcome. */
  private async select(): Promise<string | Outcome> {
    const r = this.run;
    await this.settleSplits();
    for (const m of await settleMilestones(r)) {
      if (m.attempts >= MAX_MILESTONE_REPLANS) {
        m.status = 'parked';
        m.parkedReason = `milestone checks still fail after ${m.attempts} re-plans`;
        r.events.emit('task.parked', { task: m.id, reason: m.parkedReason });
        await r.savePlan();
        continue;
      }
      m.attempts++;
      await runPlanner(r, {
        kind: 'replan',
        reason: `milestone ${m.id}'s tasks are done but its checks fail; add tasks under ${m.id} to make them pass`,
      });
    }
    const plan = r.requirePlan();
    const next = runnableTasks(plan)[0];
    if (next) return next.id;
    const expand = nextUnexpandedMilestone(plan);
    if (expand?.dependsOn.every((d) => getNode(plan, d).status === 'done')) {
      await runPlanner(r, { kind: 'expand', milestoneId: expand.id });
      const m = getNode(r.requirePlan(), expand.id);
      if (!childrenOf(r.requirePlan(), m.id).length) {
        m.status = 'parked';
        m.parkedReason = 'the planner could not expand it into tasks';
        await r.savePlan();
      }
      return this.select();
    }
    const counts = planCounts(plan);
    const openMilestones = plan.nodes.filter(
      (n) => n.type === 'milestone' && n.status !== 'done' && n.status !== 'parked',
    );
    if (
      counts.parked === 0 &&
      counts.todo === 0 &&
      openMilestones.length === 0 &&
      plan.nodes.every((n) => n.status !== 'parked')
    ) {
      await this.finalVerify();
      return {
        status: 'finished',
        reason: `all ${counts.tasks} tasks and ${counts.milestones} milestones done`,
      };
    }
    const parked = plan.nodes.filter((n) => n.status === 'parked').length;
    r.events.emit('ladder.rung', { rung: 'stop_and_ask', parked });
    return {
      status: 'needs-human',
      reason: `nothing runnable: ${parked} parked node(s) need a decision`,
    };
  }

  async loop(): Promise<Outcome> {
    const r = this.run;
    await this.resumeInFlight();
    for (;;) {
      const pre = await this.guardPre();
      if (pre) return pre;
      try {
        if (!r.plan) {
          await this.plan();
          continue;
        }
        const picked = await this.select();
        if (typeof picked !== 'string') return picked;
        await this.cycle(picked);
      } catch (err) {
        if (!(err instanceof PlannerIncomplete)) throw err;
        r.events.emit('planner.incomplete', { end: err.end });
        if (err.end === 'stop' || err.end === 'stop-now')
          return { status: 'user-stop', reason: 'stopped during planning' };
        return err.end === 'max_usd'
          ? { status: 'budget-stop', reason: 'max_usd reached while planning' }
          : {
              status: 'needs-human',
              reason: `the planner could not produce a valid plan (${err.end})`,
            };
      }
    }
  }
}

/**
 * Run one supervisor for one run until it reaches a terminal status. Takes the lock, resumes the
 * persisted phase, keeps a heartbeat, watches for stop-now, and always writes the report.
 */
export async function supervise(
  deps: RunDeps,
  runId: string,
  opts: SuperviseOptions = {},
): Promise<Outcome & { exitCode: number }> {
  const run = await Run.open(deps, runId);
  const bootId = opts.bootId ?? (await readBootId());
  const lock = await acquireLock(run.store.dir, {
    ...defaultLockEnv(bootId, deps.clock.now()),
    ...opts.lockEnv,
  });
  if (!lock.acquired) {
    throw new LockError(
      `run ${runId} is already supervised by pid ${lock.holder.pid} on ${lock.holder.host}`,
      '`omnexx status` shows its heartbeat',
    );
  }
  const pid = opts.lockEnv?.pid ?? process.pid;
  if (run.state.status === 'finished') {
    await releaseLock(run.store.dir, pid);
    return {
      status: 'finished',
      reason: run.state.statusReason ?? 'already finished',
      exitCode: EXIT.ok,
    };
  }
  const ntfy = deps.config.notify.ntfy;
  const notifier =
    opts.notifier ??
    (ntfy
      ? new NtfyNotifier(ntfy, deps.env, run.redactor, deps.fetch, (ok, detail) =>
          run.events.emit(ok ? 'notify.sent' : 'notify.failed', { detail }),
        )
      : nullNotifier);
  const sup = new Supervisor(run, notifier, opts);
  const resumed = run.state.phase !== 'init';
  if (resumed) {
    run.events.emit('run.resume', {
      fromPhase: run.state.phase,
      fromStatus: run.state.status,
      tookOverFrom: lock.tookOverFrom,
    });
    if (lock.tookOverFrom)
      await notifierSafe(() =>
        notifier.notify({
          kind: 'crash',
          runId,
          repo: run.state.repoName,
          status: run.state.phase,
        }),
      );
  } else {
    run.events.emit('run.start', {
      repo: run.state.repoName,
      branch: run.state.branch,
      budget: deps.config.budget,
    });
    await notifierSafe(() => notifier.notify({ kind: 'started', runId, repo: run.state.repoName }));
  }
  run.state.status = 'running';
  run.state.statusReason = undefined;
  run.state.budgetExhausted = false;
  await run.save();

  let sandbox: DockerSandbox | undefined;
  if (deps.config.sandbox === 'docker') {
    sandbox = new DockerSandbox(
      {
        name: `omnexx-${runId}`,
        worktree: run.worktree,
        tmpDir: run.tmpDir,
        gitDir: join(run.state.repoRoot, '.git'),
        docker: deps.config.docker,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
      },
      deps.env,
    );
    try {
      await sandbox.start();
    } catch (err) {
      await sandbox.stop();
      await releaseLock(run.store.dir, pid);
      throw err;
    }
    run.exec = sandbox.exec;
    run.events.emit('sandbox.start', {
      kind: 'docker',
      image: deps.config.docker.image,
      network: deps.config.docker.network,
    });
  }

  const stopHeartbeat = startHeartbeat(run, opts.heartbeatMs);
  const watcher = setInterval(() => {
    void run.control().then((c) => {
      if (c === 'stop-now' && !run.abort.signal.aborted) run.abort.abort(new Error('stop --now'));
    });
  }, opts.controlPollMs ?? 1_000);
  watcher.unref();

  let outcome: Outcome;
  try {
    outcome = await sup.loop();
  } catch (err) {
    if (run.abort.signal.aborted)
      outcome = { status: 'user-stop', reason: 'stopped immediately (--now)' };
    else {
      run.state.status = 'error';
      run.state.statusReason = (err as Error).message;
      await run.save();
      run.events.emit('run.error', { error: (err as Error).message });
      clearInterval(watcher);
      stopHeartbeat();
      await sandbox?.stop();
      await releaseLock(run.store.dir, pid);
      throw err;
    }
  }
  clearInterval(watcher);
  if (outcome.status === 'user-stop') await prepareWorktree(run);
  run.state.status = outcome.status;
  run.state.statusReason = outcome.reason;
  await run.setPhase('done');
  run.events.emit('run.finish', {
    status: outcome.status,
    reason: outcome.reason,
    usd: run.state.spend.usd,
    commits: run.state.acceptedCommits,
    cycles: run.state.cycle,
  });
  await writeReport(run.store, run.state, run.plan, deps.clock.now());
  const kind: NotifyKind =
    outcome.status === 'needs-human'
      ? 'needs-human'
      : outcome.status === 'budget-stop'
        ? 'budget'
        : outcome.status === 'user-stop'
          ? 'stopped'
          : 'finished';
  const counts = run.plan ? planCounts(run.plan) : undefined;
  await notifierSafe(() =>
    notifier.notify({
      kind,
      runId,
      repo: run.state.repoName,
      status: outcome.status,
      ...(counts ? { done: counts.done, total: counts.tasks, parked: counts.parked } : {}),
      commits: run.state.acceptedCommits,
      usd: run.state.spend.usd,
      budgetUsd: deps.config.budget.max_usd,
      hint: `${outcome.reason}. Report: omnexx report ${runId}`,
    }),
  );
  stopHeartbeat();
  await sandbox?.stop();
  await releaseLock(run.store.dir, pid);
  return { ...outcome, exitCode: EXIT_FOR[outcome.status] };
}

async function notifierSafe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Notifications are best effort; NtfyNotifier already logs its own failures.
  }
}
