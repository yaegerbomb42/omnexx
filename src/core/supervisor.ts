import { formatDuration, parseDuration } from '../config/duration.js';
import {
  BEYOND_RUBRIC,
  NO_TOOL_CALLS,
  PlannerIncomplete,
  plannerCandidates,
  runPlanner,
} from '../agent/planner.js';
import { allOf, WebhookNotifier } from '../notify/webhook.js';
import { openPullRequest } from '../git/pr.js';
import { closeSession } from '../tools/extra/browser.js';
import { saveToRepoMemory } from './repo-memory.js';
import { FactRecorder } from './fact-recorder.js';
import { renderCodemap, withoutVendored, type Codemap } from '../agent/codemap.js';
import { readIntent } from '../agent/intent.js';
import { git } from '../git/git.js';
import { readTextOr } from './atomic.js';
import { auditResult, blocking, clipDiff, renderFindings } from '../verify/review.js';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { settleSpecWork, specGate } from './spec-gate.js';
import { FAST_TASK, fastPathSpent, fastPlan, tryFastPath } from './fast-path.js';
import { resolveWriting } from './writing.js';
import { EXIT } from '../cli/exit-codes.js';
import { defaultSessionPool } from './exec.js';
import { DockerSandbox } from '../security/sandbox-docker.js';
import { readBootId } from '../daemon/boot-id.js';
import { LockError } from '../errors.js';
import type { OmnexxConfig } from '../config/schema.js';
import {
  dailyPauseThreshold,
  inWrapup,
  runLimitHit,
  shouldWarn,
  windowRollsAt,
} from '../guard/budget.js';
import { climb, escalateModel, LADDER, park } from '../guard/ladder.js';
import { isInCycleSignal, taskStuckSignals, type StuckFinding } from '../guard/stuck.js';
import { decideNextMove } from '../judge/next-move.js';
import type { AgentStateSummary } from '../judge/state-summary.js';
import type { NextMove } from '../judge/uses.js';
import { nullNotifier, NtfyNotifier, type Notifier, type NotifyKind } from '../notify/ntfy.js';
import { runGates } from '../verify/gates.js';
import { judgeGate } from '../verify/ratchet.js';
import {
  prepareWorktree,
  runBaseline,
  runChecks,
  stepAct,
  stepCommit,
  stepRecord,
  stepRollback,
  stepVerify,
} from './cycle.js';
import { startHeartbeat } from './heartbeat.js';
import { acquireLock, defaultLockEnv, releaseLock, type LockEnv } from './lock.js';
import type { OmnexxPaths } from './paths.js';
import { bindRun, killRunChildren, reapStaleSupervisors, unbindRun } from './process-registry.js';
import { TaskManager } from './task-manager.js';
import { initCodemap, settleMilestones } from './milestones.js';
import {
  childrenOf,
  getNode,
  nextUnexpandedMilestone,
  planCounts,
  runnableTasks,
  type Plan,
} from './plan.js';
import { evidenceText, mineEvidence } from './evidence.js';
import { writeReport } from './report.js';
import { recordFinishedRun, repoFileCount, sampleForRun, workerRef } from './run-estimate-io.js';
import type { RunStatus, RunState } from './run-store.js';
import type { ControlSignal } from '../agent/loop.js';
import type { OmnexxEvent } from './events.js';
import { Run, type RunDeps } from './run.js';

/** Read control.json once: stop-now aborts the run. Read errors must not become unhandled rejections. */
export async function pollControl(run: {
  control: () => Promise<ControlSignal>;
  abort: AbortController;
}): Promise<void> {
  try {
    const c = await run.control();
    if (c === 'stop-now' && !run.abort.signal.aborted) run.abort.abort(new Error('stop --now'));
  } catch {
    // control.json is advisory.
  }
}

export interface SuperviseOptions {
  bootId?: string;
  lockEnv?: Partial<LockEnv>;
  heartbeatMs?: number;
  controlPollMs?: number;
  pausePollMs?: number;
  notifier?: Notifier;
  /**
   * No progress for this long ends the run as blocked ("supervisor idle for 15m").
   * Default 15 minutes. A pause (or daily-cap pause) is not progress, so a paused run
   * times out too; `omnexx resume` restarts it. Wall-clock, so a warped test clock cannot
   * end a run early.
   */
  idleTimeoutMs?: number;
  /**
   * Re-load the config at each cycle boundary (project omnexx.toml, env, flags) so a mode switch
   * or config edit applies mid-run without restarting. When omitted the run keeps the config it
   * started with.
   */
  reloadConfig?: () => Promise<OmnexxConfig>;
}

export interface Outcome {
  status: RunStatus;
  reason: string;
}

export const EXIT_FOR: Record<RunStatus, number> = {
  finished: EXIT.ok,
  planned: EXIT.ok,
  blocked: EXIT.needsHuman,
  expired: EXIT.budgetStop,
  stuck: EXIT.needsHuman,
  failed: EXIT.error,
  'needs-human': EXIT.needsHuman,
  'budget-stop': EXIT.budgetStop,
  'user-stop': EXIT.userStop,
  running: EXIT.error,
  paused: EXIT.error,
  error: EXIT.error,
};

const MAX_MILESTONE_REPLANS = 2;

/** Reason for a run ended by the idle watchdog (see SuperviseOptions.idleTimeoutMs). */
export const IDLE_REASON =
  'supervisor idle for 15m with no progress (paused or stalled); resume with `omnexx resume`';

/**
 * Nothing a run spawned may outlive it: kill the registered children (process groups), then
 * the in-memory shells and background tasks. Never throws; safe to call twice.
 */
async function shutdownRunChildren(paths: OmnexxPaths, runId: string): Promise<void> {
  await killRunChildren(paths, runId).catch(() => undefined);
  try {
    defaultSessionPool.disposeAll();
  } catch {
    // A session that will not die must not fail the run's shutdown.
  }
  try {
    TaskManager.get().stopAll();
  } catch {
    // As above.
  }
}

/** Fold this run's lessons into the repo's memory so the next run or chat starts with them. */
async function rememberForRepo(run: Run, facts?: FactRecorder): Promise<void> {
  try {
    facts?.promoteNotes(await run.store.readNotes());
    await facts?.flush();
    const added = await saveToRepoMemory(
      run.deps.paths,
      run.state.repoRoot,
      await run.store.readNotes(),
      run.config.context.notes_max_tokens,
    );
    if (added) run.events.emit('memory.saved', { added });
  } catch (err) {
    run.events.emit('memory.save_failed', { error: (err as Error).message });
  }
}

/** How many times a task's line may be split before a stuck descendant is parked instead. */
const MAX_SPLIT_DEPTH = 2;

/** How many splits produced this task (0 for a task the planner wrote directly). */
export function splitDepth(plan: Plan, id: string): number {
  let depth = 0;
  let cur = id;
  for (;;) {
    const parent = plan.nodes.find((n) => n.splitInto.includes(cur));
    if (!parent) return depth;
    depth++;
    cur = parent.id;
  }
}

/** Fresh planner attempts after it ends stuck or out of turns, per supervisor process. */
const PLANNER_RETRIES = 2;

/**
 * Re-read the project's config and apply it in place, as if the run had just restarted. Emits
 * `execution.mode_change` when the execution mode changed (the state records the mode),
 * `execution.domain_change` when the work domain changed, and `config.reload_failed` when
 * the re-read failed — the previous config is then kept, so a bad edit mid-run never ends
 * the run.
 */
export async function refreshRunConfig(
  run: {
    config: OmnexxConfig;
    state: Pick<RunState, 'executionMode' | 'workDomain'>;
    save: () => Promise<void>;
    events: { emit(type: string, data?: Record<string, unknown>): OmnexxEvent };
  },
  load: () => Promise<OmnexxConfig>,
): Promise<boolean> {
  let fresh: OmnexxConfig;
  try {
    fresh = await load();
  } catch (err) {
    run.events.emit('config.reload_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  // Replace the config the run reads from now on. Model chains and the judge were built once at
  // start; plan/loop, budget, gates and review settings hot-apply from here.
  Object.assign(run.config, fresh);
  let changed = false;
  const next = fresh.execution.mode;
  const prev = run.state.executionMode;
  if (next !== prev) {
    run.state.executionMode = next;
    changed = true;
  }
  const nextDomain = fresh.execution.domain;
  const prevDomain = run.state.workDomain;
  if (nextDomain !== prevDomain) {
    run.state.workDomain = nextDomain;
    changed = true;
  }
  if (!changed) return false;
  await run.save();
  if (next !== prev) run.events.emit('execution.mode_change', { from: prev, to: next });
  if (nextDomain !== prevDomain)
    run.events.emit('execution.domain_change', { from: prevDomain, to: nextDomain });
  return true;
}

class Supervisor {
  private plannerRetries = 0;
  /** Milestones done when the goal was last checked, so the early audit runs once per milestone. */
  private milestonesChecked = 0;
  /** HEAD when the early audit found the goal met; the end-of-run audit then has nothing new to see. */
  private goalMetAt: string | undefined;

  /** Mark the current lead planner model as failed and move to the next candidate, if any. */
  private fallBackPlanner(end: string): boolean {
    const r = this.run;
    const candidates = plannerCandidates(r, r.chains.planner);
    const [lead, next] = candidates;
    if (!lead || !next) return false;
    r.plannerFailed.add(`${lead.provider}:${lead.id}`);
    this.plannerRetries = 0;
    r.events.emit('planner.fallback', {
      from: `${lead.provider}:${lead.id}`,
      to: `${next.provider}:${next.id}`,
      end,
    });
    return true;
  }

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
    r.cycleModelMs = 0;
    r.cycleToolMs = 0;
    const cycleStartElapsed = r.elapsedMs();
    const offTool = r.events.onEvent((e) => {
      if (e.type === 'tool.call' && typeof e.ms === 'number') r.cycleToolMs += e.ms;
    });
    r.state.cycle++;
    await r.setPhase('act', { taskId, pending: undefined, act: undefined });
    r.events.emit('cycle.start', { task: taskId });
    await stepAct(r);
    await stepVerify(r);
    await this.finishCycle();
    const elapsedMs = r.elapsedMs();
    r.events.emit('time.report', {
      elapsed_s: Math.round(elapsedMs / 1000),
      remaining_s: Math.max(0, Math.round((r.deadlineMs - elapsedMs) / 1000)),
      task_active_s: Math.round((elapsedMs - cycleStartElapsed) / 1000),
      model_s: Math.round(r.cycleModelMs / 1000),
      tool_s: Math.round(r.cycleToolMs / 1000),
      overrun_s: Math.max(0, Math.round((elapsedMs - r.deadlineMs) / 1000)),
      useful_ops: r.state.acceptedCommits,
    });
    offTool();
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
      // Already logged as stuck.signal in VERIFY, like oscillation.
      const inCycle = p.stuck.filter(isInCycleSignal);
      for (const signal of inCycle)
        findings.push({ signal, detail: `cycle ended early: ${signal.replace(/_/g, ' ')}` });
      for (const f of findings)
        if (f.signal !== 'oscillation' && !isInCycleSignal(f.signal))
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
          // A task that came out of splits that kept failing won't be saved by another split;
          // park it so the run moves on instead of splitting forever.
          const deep = splitDepth(r.requirePlan(), task.id) >= MAX_SPLIT_DEPTH;
          const split =
            !deep && (await this.splitTask(task.id, findings.map((f) => f.detail).join('; ')));
          task = getNode(r.requirePlan(), p.taskId);
          if (!split) {
            r.events.emit('ladder.rung', {
              task: task.id,
              rung: 'park',
              detail: park.apply(task, findings),
              fallback: deep
                ? `already split ${MAX_SPLIT_DEPTH} levels deep`
                : 'split produced no tasks',
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
      if (r.idleTimedOut) return { status: 'blocked', reason: IDLE_REASON };
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

  /**
   * Read through a method on purpose: the idle flag is set by the supervisor's watcher
   * (another closure) while guardPre runs, so a direct read would be narrowed to false by
   * the first check above and the pause loop would never see the timeout.
   */
  private idleEnded(): boolean {
    return this.run.idleTimedOut;
  }

  /** Cycle-boundary guards. Returns a terminal outcome, or undefined to keep going. */
  private async guardPre(): Promise<Outcome | undefined> {
    const r = this.run;
    // Idle for 15m with no progress (a pause is not progress): end the run so the
    // supervisor does not sit forever. blocked, not user-stop: nobody asked to stop;
    // a human decides whether to resume.
    if (r.idleTimedOut) return { status: 'blocked', reason: IDLE_REASON };
    let c = await r.control();
    if (c === 'pause') {
      r.state.status = 'paused';
      await r.save();
      r.events.emit('control.paused', { at: 'cycle-boundary' });
      while (c === 'pause') {
        await r.clock.sleep(this.opts.pausePollMs ?? 1_000);
        if (this.idleEnded()) return { status: 'blocked', reason: IDLE_REASON };
        c = await r.control();
      }
      r.state.status = 'running';
      await r.save();
      r.events.emit('control.resumed', {});
    }
    if (c === 'stop' || c === 'stop-now')
      return { status: 'user-stop', reason: 'stopped by request' };

    if (r.state.providersUnavailable) {
      const wait = r.config.budget.max_provider_wait;
      r.events.emit('budget.stop', {
        kind: 'providers_unavailable',
        detail: r.state.providersUnavailable,
      });
      return {
        status: 'expired',
        reason: `no model could take a call for ${wait} (quotas used up, keys rejected or providers down): ${r.state.providersUnavailable.slice(0, 300)}. Add a provider or wait for quotas to reset, then \`omnexx resume\`.`,
      };
    }
    if (r.state.budgetExhausted) {
      r.events.emit('budget.stop', {
        kind: 'max_usd',
        detail: 'the next model call could exceed max_usd',
      });
      return {
        status: 'expired',
        reason: `max_usd reached (${r.state.spend.usd.toFixed(2)} of ${r.config.budget.max_usd}; the next call could exceed it)`,
      };
    }
    if (r.state.taskCapHit) {
      const hit = r.state.taskCapHit;
      r.events.emit('budget.stop', {
        kind: hit.kind,
        task: hit.taskId,
        detail: hit.detail,
        checkpoint: hit.checkpoint,
      });
      return {
        status: 'expired',
        reason: `task ${hit.taskId} parked at ${hit.kind} after ${String(hit.tokens)} tokens / $${hit.usd.toFixed(2)}${hit.checkpoint ? `; state saved to ${hit.checkpoint}` : ''}. Raise [budget] task_max_* or resume to continue.`,
      };
    }
    const paused = await this.dailyCapPause();
    if (paused) return paused;
    const limits = {
      spentUsd: r.state.spend.usd,
      elapsedMs: r.elapsedMs(),
      cycles: r.state.cycle,
      turns: r.state.spend.turns,
    };
    const hit = runLimitHit(r.config.budget, limits);
    if (hit) {
      r.events.emit('budget.stop', { kind: hit.kind, detail: hit.detail });
      return { status: 'expired', reason: `${hit.kind} reached (${hit.detail})` };
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
        status: 'expired',
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
      if (await this.recoverNoProgress(sinceCycles)) return undefined;
      return { status: 'blocked', reason: `no accepted commit for ${sinceCycles} cycles` };
    }
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
    const goal = (await r.store.readGoal()).text;
    if (!r.state.writing && resolveWriting(r.config, goal)) {
      r.state.writing = true;
      r.events.emit('run.kind', { kind: 'writing' });
    }
    // Writing runs always plan: a manuscript needs its outline and bible before the first page.
    const fast = !r.state.writing && r.state.fastPath === undefined && tryFastPath(r.config, goal);
    await initCodemap(r, { describe: !fast });
    if (!r.state.baseline) await runBaseline(r);
    if (fast) {
      r.plan = fastPlan(r.config, goal);
      await r.savePlan();
      r.state.fastPath = 'tried';
      await r.save();
      r.events.emit('plan.written', { mode: 'fast', nodes: r.plan.nodes.length, turns: 0, usd: 0 });
    } else {
      await runPlanner(r, { kind: 'initial' });
    }
    await r.setPhase('select');
  }

  /** The fast path had its tries: drop its one-task plan so the planner plans from here. */
  private async fastPathFallback(): Promise<boolean> {
    const r = this.run;
    if (r.state.fastPath !== 'tried' || !r.plan) return false;
    if (!fastPathSpent(r.plan, r.config.plan.fast_attempts)) return false;
    r.state.fastPath = 'failed';
    r.events.emit('fast_path.fallback', { attempts: getNode(r.plan, FAST_TASK).attempts });
    r.plan = undefined;
    await rm(r.store.file('plan.json'), { force: true });
    await r.save();
    return true;
  }

  /**
   * Beyond mode: the goal is met, so ask the planner for one more round of verified improvements.
   * True when it added runnable work; false when it's off, out of rounds or budget, or the
   * planner found nothing worth doing (it returns the plan unchanged).
   */
  /**
   * Before a run may finish: an independent auditor compares the result with what was asked (goal,
   * inferred intent and its "done when" list). Gaps become a new milestone, so "done" is earned,
   * not declared. Fails open; stops after `max_audits` rounds.
   */
  private async planAudit(): Promise<boolean> {
    const r = this.run;
    const cfg = r.config.review;
    // A goal the fast path finished is small: one round of gaps, not a series of re-audits that
    // each find something new to add (bench task-02's second round planned 10 nodes of polish).
    const maxRounds = r.state.fastPath === 'tried' ? 1 : cfg.max_audits;
    // Reaching here means the last round's work is finished: improvement rounds after it are not
    // audit work and must not inherit its cycle budget.
    r.state.auditWorkFrom = undefined;
    if (!cfg.audit || r.state.auditRounds >= maxRounds) return false;
    // The fast path's loop session already reviewed the whole diff against the goal and fixed
    // what it found in the same conversation; a second look would only plan polish for fresh workers.
    if (r.state.fastPath === 'tried' && r.state.loopReviewed) return false;
    if (this.goalMetAt && this.goalMetAt === (await this.head())) return false;
    const result = await this.audit();
    const round = r.state.auditRounds + 1;
    r.state.auditRounds = round;
    await r.save();
    if (!result) return false;
    const gaps = blocking(result.findings, 'major');
    r.events.emit('audit.result', { round, findings: result.findings.length, gaps: gaps.length });
    if (!gaps.length) return false;
    const before = r.requirePlan().nodes.length;
    try {
      await runPlanner(r, { kind: 'audit', round, gaps: renderFindings(gaps) });
    } catch (err) {
      if (!(err instanceof PlannerIncomplete)) throw err;
      return false;
    }
    const added =
      r.requirePlan().nodes.length > before && runnableTasks(r.requirePlan()).length > 0;
    if (added) {
      r.state.auditWorkFrom = r.state.cycle;
      await r.save();
    }
    return added;
  }

  /**
   * Audit work runs on a tree that already passed every gate, so it gets `audit_max_cycles`
   * cycles. What is still open then is skipped (the report lists it), no further audit runs, and
   * the run finishes on the last green commit instead of grinding on gaps the auditor imagined.
   */
  private async auditOverBudget(): Promise<void> {
    const r = this.run;
    const from = r.state.auditWorkFrom;
    if (from === undefined) return;
    const cycles = r.state.cycle - from;
    if (cycles < r.config.review.audit_max_cycles) return;
    const open = r.requirePlan().nodes.filter((n) => n.status === 'todo' || n.status === 'doing');
    r.state.auditWorkFrom = undefined;
    if (open.length) {
      for (const n of open) {
        n.status = 'parked';
        n.skipped = true;
        n.parkedReason = `audit follow-up skipped: over its ${cycles}-cycle budget`;
      }
      r.state.auditRounds = Math.max(r.state.auditRounds, r.config.review.max_audits);
      r.events.emit('audit.budget_spent', { cycles, skipped: open.map((n) => n.id) });
      await r.savePlan();
    }
    await r.save();
  }

  private async head(): Promise<string> {
    return (await git(this.run.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** The auditor's view of everything this run changed, against the goal and intent. */
  private async audit(): Promise<Awaited<ReturnType<typeof auditResult>>> {
    const r = this.run;
    const cfg = r.config.review;
    const goal = (await r.store.readGoal()).text;
    const intent = await readIntent(r.store);
    const codemapText = await readTextOr(r.store.file('codemap.json'), '');
    const map = codemapText
      ? renderCodemap(JSON.parse(codemapText) as Codemap, r.config.context.repo_map_max_tokens)
      : '';
    const diff = withoutVendored(
      (await git(r.worktree, ['diff', `${r.state.startRef}..HEAD`], { allowFailure: true })).stdout,
    );
    return auditResult(
      r,
      goal,
      intent,
      `${map}\n\n# Everything this run changed (diff from the start)\n${clipDiff(diff, cfg.max_diff_chars * 2)}`,
      r.workerPrefix,
    );
  }

  /**
   * Planners pad small goals with extra milestones (hardening, polish) that cost more than the goal.
   * Each time a milestone finishes with more still open, the auditor checks the goal; when nothing
   * the user asked for is missing, the open work is skipped and the run moves on to finish. Off in
   * improvement rounds and autonomous runs, which exist to do more than the goal.
   */
  private async goalMetEarly(): Promise<boolean> {
    const r = this.run;
    const plan = r.requirePlan();
    const done = planCounts(plan).milestonesDone;
    if (done <= this.milestonesChecked) return false;
    this.milestonesChecked = done;
    if (!r.config.review.audit || r.state.beyondRounds > 0 || r.config.autonomous.enabled)
      return false;
    const open = plan.nodes.filter((n) => n.status === 'todo' || n.status === 'doing');
    if (!open.some((n) => n.type === 'milestone')) return false;
    const result = await this.audit();
    if (!result) return false;
    const gaps = blocking(result.findings, 'major');
    r.events.emit('audit.early', { milestonesDone: done, gaps: gaps.length });
    if (gaps.length) return false;
    for (const n of open) {
      n.status = 'parked';
      n.skipped = true;
      n.parkedReason = 'not needed: the goal is already met';
    }
    r.events.emit('plan.skipped', { nodes: open.map((n) => n.id) });
    this.goalMetAt = await this.head();
    await r.savePlan();
    return true;
  }

  private async planBeyond(): Promise<boolean> {
    const r = this.run;
    const cfg = r.config.beyond;
    const auto = r.config.autonomous.enabled;
    if (!this.beyondAllowed()) return false;
    const before = r.requirePlan().nodes.length;
    const round = r.state.beyondRounds + 1;
    const scope = auto
      ? { focus: autonomousFocus(r.config.autonomous.focus, round) }
      : { maxRounds: cfg.max_rounds };
    const findings = await mineEvidence(r.worktree, new Set(r.state.evidenceShown));
    r.state.evidenceShown = [...r.state.evidenceShown, ...findings.map((f) => f.path)].slice(
      -EVIDENCE_MEMORY,
    );
    r.events.emit('beyond.start', { round, ...scope, evidence: findings.length });
    try {
      await runPlanner(r, {
        kind: 'beyond',
        round,
        ...scope,
        ...(findings.length ? { evidence: evidenceText(findings) } : {}),
      });
    } catch (err) {
      // One bad planning round must not end a day-long run; it counts as a round with no work.
      if (!auto || !(err instanceof PlannerIncomplete)) throw err;
      r.events.emit('autonomous.round_failed', { round, end: err.end });
    }
    const added = r.requirePlan().nodes.length - before;
    r.state.beyondRounds = round;
    const found = added > 0 && runnableTasks(r.requirePlan()).length > 0;
    if (auto) this.countIdle(round, found);
    await r.save();
    r.events.emit('beyond.round', { round, added });
    if (auto && !found) return r.state.idleRounds < r.config.autonomous.max_idle_rounds;
    return found;
  }

  /** Whether another improvement round may start: enabled, under the round cap, budget left. */
  private beyondAllowed(): boolean {
    const r = this.run;
    const cfg = r.config.beyond;
    const auto = r.config.autonomous.enabled;
    if (!auto && (!cfg.enabled || r.state.beyondRounds >= cfg.max_rounds)) return false;
    // Autonomous runs use the clock to the end; only the wrap-up reserve is kept back.
    const minLeft = r.config.budget.wrapup_reserve * 2;
    if (r.budgetLeftFraction() >= (auto ? minLeft : Math.max(cfg.min_budget_left, minLeft)))
      return true;
    r.events.emit('beyond.skip', { reason: 'budget', left: r.budgetLeftFraction() });
    return false;
  }

  private countIdle(round: number, found: boolean): void {
    const r = this.run;
    r.state.idleRounds = found ? 0 : r.state.idleRounds + 1;
    if (!found) r.events.emit('autonomous.idle', { round, idle: r.state.idleRounds });
  }

  /**
   * Autonomous mode has nobody to ask when nothing gets accepted for a while: park the work in
   * progress (it is listed in the report) and let the run move on to other tasks or the next
   * improvement round. Only `max_idle_rounds` recoveries in a row; an accepted commit resets it.
   */
  private async recoverNoProgress(sinceCycles: number): Promise<boolean> {
    const r = this.run;
    if (!r.config.autonomous.enabled) return false;
    if (r.state.recoveries >= r.config.autonomous.max_idle_rounds) return false;
    const plan = r.requirePlan();
    const stuck = plan.nodes.filter(
      (n) =>
        n.type === 'task' &&
        (n.status === 'doing' || n.id === r.state.taskId) &&
        n.status !== 'done',
    );
    for (const n of stuck) {
      n.status = 'parked';
      n.parkedReason = `autonomous: no progress for ${sinceCycles} cycles; moved on`;
    }
    r.state.recoveries++;
    r.state.lastProgressCycle = r.state.cycle;
    r.state.lastProgressAt = r.clock.now();
    await r.savePlan();
    await r.save();
    r.events.emit('autonomous.recover', {
      parked: stuck.map((n) => n.id),
      recovery: r.state.recoveries,
      cycles: sinceCycles,
    });
    return true;
  }

  /**
   * Autonomous mode has nobody to ask: work that can't proceed because something it needs was
   * parked is parked too, so the run moves on to the next improvement round. The report lists it.
   */
  private async parkBlocked(): Promise<boolean> {
    const r = this.run;
    const blocked = r
      .requirePlan()
      .nodes.filter((n) => n.status !== 'done' && n.status !== 'parked');
    if (!blocked.length) return false;
    for (const n of blocked) {
      n.status = 'parked';
      n.parkedReason = 'autonomous: blocked by parked work';
    }
    await r.savePlan();
    r.events.emit('autonomous.skipped', { nodes: blocked.map((n) => n.id) });
    return true;
  }

  /** Milestones, rolling-wave expansion, and the end-of-plan decision. Returns a task id or an outcome. */
  private async select(): Promise<string | Outcome> {
    const r = this.run;
    await this.settleSplits();
    await this.auditOverBudget();
    await settleSpecWork(r);
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
    await this.goalMetEarly();
    const plan = r.requirePlan();
    const next = runnableTasks(plan)[0];
    if (next) return next.id;
    const expand = nextUnexpandedMilestone(plan);
    if (expand?.dependsOn.every((d) => getNode(plan, d).status === 'done')) {
      await runPlanner(r, { kind: 'expand', milestoneId: expand.id });
      const m = getNode(r.requirePlan(), expand.id);
      if (!childrenOf(r.requirePlan(), m.id).length) {
        // No tasks came out. Planners add setup milestones ("install deps, confirm the baseline")
        // with nothing to change: if its checks pass, it's done. Otherwise park it, but don't let
        // it block the milestones after it forever (a whole run once stalled on one).
        const checks = m.checks.length ? await runChecks(r, m, `${m.id}-noexpand`) : [];
        if (checks.length && checks.every((c) => c.pass)) {
          m.status = 'done';
          r.events.emit('milestone.no_work', { milestone: m.id });
        } else {
          m.status = 'parked';
          m.parkedReason = 'the planner could not expand it into tasks';
          const released = r
            .requirePlan()
            .nodes.filter((n) => n.dependsOn.includes(m.id))
            .map((n) => {
              n.dependsOn = n.dependsOn.filter((d) => d !== m.id);
              return n.id;
            });
          if (released.length) r.events.emit('milestone.released', { parked: m.id, released });
        }
        await r.savePlan();
      }
      return this.select();
    }
    const counts = planCounts(plan);
    const openMilestones = plan.nodes.filter(
      (n) => n.type === 'milestone' && n.status !== 'done' && n.status !== 'parked',
    );
    // Autonomous runs skip parked work instead of stopping to ask; the report lists it.
    const auto = r.config.autonomous.enabled;
    if (
      counts.todo === 0 &&
      openMilestones.length === 0 &&
      (auto || plan.nodes.every((n) => n.status !== 'parked' || n.skipped))
    ) {
      if (await specGate(r)) return this.select();
      if (await this.planAudit()) return this.select();
      if (await this.planBeyond()) return this.select();
      await this.finalVerify();
      const rounds = r.state.beyondRounds;
      return {
        status: 'finished',
        reason: `all ${counts.tasks} tasks and ${counts.milestones} milestones done${rounds ? ` (goal plus ${rounds} improvement round${rounds === 1 ? '' : 's'})` : ' (goal only)'}`,
      };
    }
    if (r.config.autonomous.enabled && (await this.parkBlocked())) return this.select();
    const parked = plan.nodes.filter((n) => n.status === 'parked').length;
    r.events.emit('ladder.rung', { rung: 'stop_and_ask', parked });
    return {
      status: 'blocked',
      reason: `nothing runnable: ${parked} parked node(s) need a decision`,
    };
  }

  async loop(): Promise<Outcome> {
    const r = this.run;
    await this.resumeInFlight();
    for (;;) {
      // Hot config/mode switch: apply at the next cycle boundary, without a restart.
      if (this.opts.reloadConfig) await refreshRunConfig(r, this.opts.reloadConfig);
      const pre = await this.guardPre();
      if (pre) return pre;
      try {
        if (!r.plan) {
          await this.plan();
          continue;
        }
        if (await this.fastPathFallback()) continue;
        const picked = await this.select();
        if (typeof picked !== 'string') return picked;
        await this.cycle(picked);
        // Retries are per wedge, not per run: a long run may hit several over its hours.
        this.plannerRetries = 0;
      } catch (err) {
        if (!(err instanceof PlannerIncomplete)) throw err;
        r.events.emit('planner.incomplete', { end: err.end });
        // A planner that got wedged (a request the provider chokes on, turns or tokens burned on
        // invalid plans, or a model that stopped without a valid plan) gets a fresh conversation
        // before the run stops for a human: one bad planning turn shouldn't end a long run.
        if (
          (err.end === 'stuck' ||
            err.end === 'max_turns_per_cycle' ||
            err.end === 'max_tokens_per_cycle' ||
            err.end === 'done' ||
            err.end === NO_TOOL_CALLS) &&
          this.plannerRetries < PLANNER_RETRIES
        ) {
          this.plannerRetries++;
          r.events.emit('planner.retry', { attempt: this.plannerRetries, end: err.end });
          continue;
        }
        if (err.end === 'stop' || err.end === 'stop-now')
          return { status: 'user-stop', reason: 'stopped during planning' };
        // Retries used up on this model: plan with the next one before asking anyone.
        if (err.end !== 'max_usd' && this.fallBackPlanner(err.end)) continue;
        return err.end === 'max_usd'
          ? { status: 'expired', reason: 'max_usd reached while planning' }
          : {
              status: 'blocked',
              reason:
                err.end === NO_TOOL_CALLS
                  ? 'the planner model never called a tool: it (or the server in front of it) may not support tool calling; pick another planner model with `omnexx models`'
                  : `the planner could not produce a valid plan (${err.end})`,
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
  // A previous supervisor for this (or any) run may have died wedged or crashed: reap its
  // orphans before taking the lock, so a stale holder cannot block this resume.
  await reapStaleSupervisors(deps.paths, {
    log: (line) => {
      console.error(line);
    },
  }).catch(() => undefined);
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
  // From here on this process owns the run: children spawned (shells, servers, tasks,
  // daemons) register under it, and run end kills them.
  bindRun(deps.paths, runId);
  const ntfy = deps.config.notify.ntfy;
  const onResult = (ok: boolean, detail: string): void => {
    run.events.emit(ok ? 'notify.sent' : 'notify.failed', { detail });
  };
  const hook = deps.config.notify.webhook;
  const channels = [
    ...(ntfy ? [new NtfyNotifier(ntfy, deps.env, run.redactor, deps.fetch, onResult)] : []),
    ...(hook ? [new WebhookNotifier(hook, deps.env, run.redactor, deps.fetch, onResult)] : []),
  ];
  const notifier = opts.notifier ?? (channels.length ? allOf(channels) : nullNotifier);
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
  run.state.providersUnavailable = undefined;
  run.state.taskCapHit = undefined;
  run.taskBudget.begin(run.state.taskId);
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

  // Every command the run executes (setup, gates, the agent's bash) keeps the repo's facts current.
  const facts = new FactRecorder({
    paths: run.deps.paths,
    repoRoot: run.state.repoRoot,
    workdir: run.worktree,
    gateCommands: run.config.gates.map((g) => g.run),
    now: () => run.clock.now(),
    onError: (err) => run.events.emit('facts.save_failed', { error: err.message }),
  });
  run.exec = facts.wrap(run.exec);
  const stopHeartbeat = startHeartbeat(run, opts.heartbeatMs);
  // Stall watchdog: any event is activity; a working cycle that goes silent too long is hung.
  let lastActivity = run.clock.now();
  // Idle watchdog: same activity, on the wall clock. A pause emits no events, so a paused run
  // goes idle and ends after `idleTimeoutMs` instead of holding a supervisor forever.
  let lastProgressWall = Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 15 * 60_000;
  const offActivity = run.events.onEvent(() => {
    lastActivity = run.clock.now();
    lastProgressWall = Date.now();
  });
  const maxSilence = parseDuration(run.config.stuck.max_silence);
  const watcher = setInterval(() => {
    void pollControl(run);
    const silent = run.clock.now() - lastActivity;
    if (run.state.phase === 'act' && !run.paused && silent >= maxSilence)
      run.abortCycle(`no activity for ${formatDuration(silent)} while working`);
    // Caps are checked between cycles; one long cycle must not carry the run past max_hours.
    else if (run.state.phase === 'act' && !run.paused && run.elapsedMs() >= run.deadlineMs)
      run.endCycleAtDeadline();
    if (!run.idleTimedOut && Date.now() - lastProgressWall >= idleTimeoutMs) {
      run.idleTimedOut = true;
      run.events.emit('supervisor.idle_timeout', {
        idleMs: Date.now() - lastProgressWall,
      });
    }
  }, opts.controlPollMs ?? 1_000);
  watcher.unref();
  const stopWatching = (): void => {
    clearInterval(watcher);
    offActivity();
    stopHeartbeat();
  };

  let outcome: Outcome;
  try {
    try {
      outcome = await sup.loop();
    } catch (err) {
      if (run.abort.signal.aborted)
        outcome = { status: 'user-stop', reason: 'stopped immediately (--now)' };
      else {
        run.state.status = 'failed';
        run.state.statusReason = (err as Error).message;
        await run.save();
        run.events.emit('run.error', { error: (err as Error).message });
        await closeSession(runId).catch(() => undefined);
        await rememberForRepo(run, facts);
        await sandbox?.stop();
        await releaseLock(run.store.dir, pid);
        throw err;
      }
    }
    // No browser outlives its run (a cycle that threw may have skipped its own cleanup).
    await closeSession(runId).catch(() => undefined);
    // Nothing else a run spawned outlives it either: shells (and servers backgrounded
    // inside them), dev servers, background tasks and daemons.
    await shutdownRunChildren(deps.paths, runId);
    await rememberForRepo(run, facts);
    if (outcome.status === 'user-stop') await prepareWorktree(run);
    run.state.status = outcome.status;
    run.state.statusReason = outcome.reason;
    await run.setPhase('done');
    const elapsedMs = run.elapsedMs();
    run.events.emit('time.report', {
      elapsed_s: Math.round(elapsedMs / 1000),
      remaining_s: Math.max(0, Math.round((run.deadlineMs - elapsedMs) / 1000)),
      task_active_s: 0,
      model_s: Math.round(run.cycleModelMs / 1000),
      tool_s: Math.round(run.cycleToolMs / 1000),
      overrun_s: Math.max(0, Math.round((elapsedMs - run.deadlineMs) / 1000)),
      useful_ops: run.state.acceptedCommits,
    });
    run.events.emit('run.finish', {
      status: outcome.status,
      reason: outcome.reason,
      usd: run.state.spend.usd,
      commits: run.state.acceptedCommits,
      cycles: run.state.cycle,
    });
    await writeReport(run.store, run.state, run.plan, deps.clock.now(), {
      maxHours: deps.config.budget.max_hours,
      ...(deps.config.budget.max_turns !== undefined
        ? { maxTurns: deps.config.budget.max_turns }
        : {}),
      maxUsd: deps.config.budget.max_usd,
      maxCycles: deps.config.budget.max_cycles,
    });
    await rememberRunTook(run, deps, outcome.status);
    const prUrl = deps.config.git.open_pr ? await openPullRequest(run) : undefined;
    const kind: NotifyKind =
      outcome.status === 'blocked'
        ? 'needs-human'
        : outcome.status === 'expired'
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
        ...(prUrl ? { url: prUrl } : {}),
      }),
    );
    await sandbox?.stop();
    await releaseLock(run.store.dir, pid);
    return { ...outcome, exitCode: EXIT_FOR[outcome.status] };
  } finally {
    // Belt and braces for the error path above (which rethrows after its own cleanup):
    // a run that ends any other way still leaves nothing behind.
    await shutdownRunChildren(deps.paths, runId);
    unbindRun();
    stopWatching();
    // The persistent shells outlive the run otherwise: their bash child keeps the Node
    // event loop alive, so a foreground `omnexx run` never returns after `run.finish`.
    defaultSessionPool.disposeAll();
  }
}

async function notifierSafe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Notifications are best effort; NtfyNotifier already logs its own failures.
  }
}

/** How many shown evidence paths a run remembers before it may show one again. */
const EVIDENCE_MEMORY = 200;

/** Autonomous round n's focus: the user's areas first, then the beyond rubric, round robin. */
export function autonomousFocus(extra: readonly string[], round: number): string {
  const areas = [...extra, ...BEYOND_RUBRIC];
  return areas[(round - 1) % areas.length] ?? '';
}

/** Add this run to the history the next run's estimate comes from. */
async function rememberRunTook(run: Run, deps: RunDeps, status: string): Promise<void> {
  const goal = await run.store.readGoal().catch(() => ({ text: '' }));
  const sample = sampleForRun(run.state, run.plan, {
    model: workerRef(deps.config),
    goalChars: goal.text.trim().length,
    repoFiles: await repoFileCount(run.worktree),
    at: deps.clock.now(),
  });
  await recordFinishedRun(deps.paths, sample, status);
}
