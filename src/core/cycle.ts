import { join } from 'node:path';
import { buildCycleContext } from '../agent/context.js';
import { renderCodemap, type Codemap } from '../agent/codemap.js';
import { runAgentLoop } from '../agent/loop.js';
import { WORKER_SYSTEM } from '../agent/prompts.js';
import { StateError } from '../errors.js';
import { commitCheckpoint } from '../git/checkpoint.js';
import { git } from '../git/git.js';
import { commitMessage, headSha, isClean, workingTreeDiff } from '../git/repo.js';
import { rollbackTo } from '../git/rollback.js';
import { parseTrailers } from '../git/trailers.js';
import { PathJail } from '../security/paths.js';
import { detectOscillation } from '../guard/stuck.js';
import {
  CONFIDENT_FALSE,
  CONFIDENT_TRUE,
  driftQuestion,
  sameFailureQuestion,
  toolSafetyQuestion,
} from '../judge/uses.js';
import { WORKER_TOOLS, toolSpec } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { antiCheat } from '../verify/anticheat.js';
import { runGates, toBaseline, type GateResult } from '../verify/gates.js';
import { failureSignature, judgeGate } from '../verify/ratchet.js';
import { readTextOr } from './atomic.js';
import { renderNotes } from './notes.js';
import { refreshCodemap } from './milestones.js';
import { getNode, type PlanNode } from './plan.js';
import type { PendingVerdict } from './run-store.js';
import type { Run } from './run.js';

const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Rejection reason for a cycle a budget cap cut short before it changed anything: not an attempt. */
export const INTERRUPTED_BY_BUDGET = 'interrupted by a budget cap before any change';

export interface CheckResult {
  command: string;
  pass: boolean;
  output: string;
}

/** Run a task's acceptance checks (shell commands) in the worktree. All must exit 0. */
export async function runChecks(run: Run, task: PlanNode, label: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const [i, command] of task.checks.entries()) {
    const r = await run.exec(command, {
      cwd: run.worktree,
      env: run.childEnv,
      timeoutMs: Math.min(CHECK_TIMEOUT_MS, run.maxCmdTimeoutMs),
      logPath: join(run.store.logsDir, `check-${label}-${i}.log`),
      redact: (s) => run.redactor.text(s),
      signal: run.abort.signal,
    });
    out.push({
      command,
      pass: r.exitCode === 0 && !r.timedOut,
      output: r.output.split('\n').slice(-20).join('\n'),
    });
  }
  return out;
}

function gateRunCtx(run: Run, label: string) {
  return {
    exec: run.exec,
    cwd: run.worktree,
    env: run.childEnv,
    logsDir: run.store.logsDir,
    label,
    maxCmdTimeoutMs: run.maxCmdTimeoutMs,
    redact: (s: string) => run.redactor.text(s),
    signal: run.abort.signal,
  };
}

/** Record which tests and errors already fail at the starting commit (plan §3.8). */
export async function runBaseline(run: Run): Promise<void> {
  const results = await runGates(run.config.gates, gateRunCtx(run, 'baseline'));
  run.state.baseline = toBaseline(results);
  run.state.initialBaseline ??= run.state.baseline;
  await run.save();
  run.events.emit('baseline', {
    gates: results.map((r) => ({
      gate: r.name,
      exitCode: r.exitCode,
      failures: r.failures.length,
      tests: r.tests,
    })),
  });
}

async function loadCodemap(run: Run): Promise<string> {
  const text = await readTextOr(run.store.file('codemap.json'), '');
  if (!text) return '# Codebase map\n(not built yet; explore with search and outline)';
  return renderCodemap(JSON.parse(text) as Codemap, run.config.context.repo_map_max_tokens);
}

/** PREPARE: the worktree must sit exactly on lastGreen with a clean tree before ACT. */
export async function prepareWorktree(run: Run): Promise<void> {
  const head = await headSha(run.worktree);
  const clean = await isClean(run.worktree);
  if (head === run.state.lastGreen && clean) return;
  const patch = join(run.store.dir, 'salvage', `${run.state.cycle}.patch`);
  await rollbackTo(
    run.worktree,
    run.state.lastGreen,
    clean ? undefined : { path: patch, redact: (x) => run.redactor.text(x) },
  );
  run.events.emit('reconcile.salvage', {
    head,
    lastGreen: run.state.lastGreen,
    dirty: !clean,
    patch: clean ? undefined : patch,
  });
}

function toolContext(run: Run, edited: Set<string>): ToolContext {
  let n = 0;
  const { judge } = run;
  return {
    jail: new PathJail(run.worktree),
    exec: run.exec,
    env: run.childEnv,
    store: run.store,
    events: run.events,
    redactor: run.redactor,
    policy: run.policy(),
    cycle: run.state.cycle,
    maxCmdTimeoutMs: run.maxCmdTimeoutMs,
    notesMaxTokens: run.config.context.notes_max_tokens,
    today: new Date(run.clock.now()).toISOString().slice(0, 10),
    signal: run.abort.signal,
    nextCommandId: () => `cmd-${run.state.cycle}-${++n}`,
    edited,
    // Advisory, log-only, never awaited by the tool, skipped while the breaker is open.
    ...(judge.enabled('tool_safety') && judge.breakerState !== 'open'
      ? {
          onBash: (command: string) => {
            void judge
              .ask('tool_safety', { command, task: run.state.taskId }, [toolSafetyQuestion])
              .then((r) => {
                const p =
                  r.status === 'answered' && r.answers[0]?.type === 'noul'
                    ? r.answers[0].probability
                    : undefined;
                if (p !== undefined && p >= CONFIDENT_TRUE)
                  run.events.emit('judge.tool_flag', { command, probability: p });
              });
          },
        }
      : {}),
  };
}

/** ACT: zero-cost preflight on the task's checks, then the agent loop with a fresh context. */
export async function stepAct(run: Run): Promise<void> {
  const plan = run.requirePlan();
  const task = getNode(plan, run.state.taskId ?? '');
  await prepareWorktree(run);

  if (task.checks.length && task.attempts === 0) {
    const pre = await runChecks(run, task, `${run.state.cycle}-pre`);
    if (pre.every((c) => c.pass)) {
      run.events.emit('task.already_done', { task: task.id });
      run.state.act = {
        summary: 'acceptance checks already pass; no changes needed',
        end: 'already-done',
        turns: 0,
        usd: 0,
      };
      await run.setPhase('verify');
      return;
    }
  }

  const edited = new Set<string>();
  const toolCtx = toolContext(run, edited);
  const [goal, notes, progressTail, codemap] = await Promise.all([
    run.store.readGoal(),
    run.store.readNotes(),
    run.store.progressTail(run.config.context.progress_tail),
    loadCodemap(run),
  ]);
  const ctx = buildCycleContext({
    systemPrompt: WORKER_SYSTEM,
    codemap,
    goal: goal.text,
    notes: renderNotes(notes),
    plan,
    task,
    progressTail,
    evidence: task.evidence.slice(-3),
    tools: WORKER_TOOLS.map(toolSpec),
  });
  run.events.emit('cycle.context', {
    task: task.id,
    prefixBytes: ctx.system.reduce((n, b) => n + b.text.length, 0),
    stateBytes: JSON.stringify(ctx.first).length,
  });
  const result = await runAgentLoop(ctx, {
    provider: run.deps.provider,
    model: task.escalated ? run.models.planner : run.models.worker,
    tools: WORKER_TOOLS,
    toolCtx,
    budget: run.config.budget,
    maxTokens: run.config.providers.anthropic.max_tokens,
    clock: run.clock,
    events: run.events,
    spentUsd: () => run.state.spend.usd,
    spentTodayUsd: () => run.spentToday(),
    onUsage: (u, usd, model) => run.addSpend(u, usd, model, 'worker'),
    control: () => run.control(),
    onPauseChange: (p) => {
      run.paused = p;
    },
    signal: run.abort.signal,
  });
  if (result.end === 'max_usd') run.state.budgetExhausted = true;
  if (result.end === 'max_usd_per_day') run.state.dailyCapHit = true;
  run.events.emit('act.end', {
    end: result.end,
    turns: result.turns,
    usd: result.usd,
    edited: [...edited],
  });
  run.state.act = {
    summary: run.redactor.text(result.finalText).slice(0, 2_000),
    end: result.end,
    turns: result.turns,
    usd: result.usd,
  };
  await run.setPhase('verify');
}

function renderFailures(
  results: readonly GateResult[],
  verdicts: ReturnType<typeof judgeGate>[],
): string {
  const lines: string[] = [];
  for (const [i, r] of results.entries()) {
    const v = verdicts[i];
    if (!v || v.pass) continue;
    lines.push(`Gate ${r.name}: ${v.reason ?? 'failed'}`);
    const fresh = new Set(v.newFailures);
    for (const f of r.failures.filter((x) => fresh.size === 0 || fresh.has(x.id)).slice(0, 10)) {
      lines.push(
        `- ${f.id}${f.location ? ` (${f.location})` : ''}\n  ${f.message.split('\n').join('\n  ')}`,
      );
    }
  }
  return lines.join('\n');
}

/** VERIFY + JUDGE: gates against the baseline, anti-cheat, oscillation, task checks. Harness decides. */
export async function stepVerify(run: Run): Promise<void> {
  const plan = run.requirePlan();
  const task = getNode(plan, run.state.taskId ?? '');
  const act = run.state.act ?? { summary: '', end: 'crashed', turns: 0, usd: 0 };
  const { changes, patch, treeHash } = await workingTreeDiff(run.worktree, run.state.lastGreen);
  const diffStats = {
    files: changes.length,
    added: changes.reduce((n, c) => n + c.added, 0),
    removed: changes.reduce((n, c) => n + c.removed, 0),
  };
  const reasons: string[] = [];
  const evidence: string[] = [];
  const stuck: string[] = [];
  let baseline = run.state.baseline;
  let testsPassed: number | undefined;
  const label = `c${run.state.cycle}`;

  if (act.end === 'stop-now') reasons.push('stopped by user (--now)');

  const checks = task.checks.length ? await runChecks(run, task, label) : [];
  const checksPass = checks.every((c) => c.pass);
  for (const c of checks.filter((x) => !x.pass))
    evidence.push(`Check failed: \`${c.command}\`\n${c.output}`);

  const budgetCut = act.end === 'max_usd' || act.end === 'max_usd_per_day';
  if (!changes.length) {
    if (budgetCut) reasons.push(INTERRUPTED_BY_BUDGET);
    else if (!(task.checks.length && checksPass)) reasons.push('no changes');
  } else if (!reasons.length) {
    const results = await runGates(run.config.gates, gateRunCtx(run, label));
    const verdicts = results.map((r) => judgeGate(r, run.state.baseline));
    for (const v of verdicts) if (!v.pass) reasons.push(`gate ${v.gate}: ${v.reason ?? 'failed'}`);
    const failText = renderFailures(results, verdicts);
    if (failText) evidence.push(failText);
    testsPassed = results.reduce((n, r) => n + (r.tests?.passed ?? 0), 0) || undefined;
    for (const v of antiCheat({
      changes,
      patch,
      protectedPatterns: run.config.protected,
      allow: task.allow,
      baseline: run.state.baseline,
      results,
    })) {
      reasons.push(`anti-cheat ${v.rule}: ${v.detail}`);
      evidence.push(`Rejected by anti-cheat (${v.rule}): ${v.detail}. Do not do this.`);
    }
    const osc = await detectOscillation(
      run.worktree,
      run.state.lastGreen,
      run.state.greenHistory
        .slice(-run.config.stuck.oscillation_window - 1, -1)
        .map((g) => g.sha)
        .reverse(),
      changes,
    );
    if (osc) {
      reasons.push(`stuck ${osc.signal}: ${osc.detail}`);
      stuck.push(osc.signal);
      evidence.push(
        `Rejected: ${osc.detail}. Find an approach that keeps the earlier accepted work.`,
      );
      run.events.emit('stuck.signal', { signal: osc.signal, task: task.id, detail: osc.detail });
    }
    baseline = toBaseline(results);
    run.events.emit('verify.gates', {
      gates: results.map((r, i) => ({
        gate: r.name,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        failures: r.failures.length,
        newFailures: verdicts[i]?.newFailures.length ?? 0,
        fixed: verdicts[i]?.fixed.length ?? 0,
        tests: r.tests,
        durationMs: r.durationMs,
      })),
    });
  }

  // Advisory drift check: may add evidence, never changes the verdict.
  if (changes.length && run.judge.enabled('drift')) {
    const r = await run.judge.ask(
      'drift',
      {
        goal: (await run.store.readGoal()).text.slice(0, 1_500),
        task: { id: task.id, title: task.title },
        files: changes.map((c) => `${c.status} ${c.path} +${c.added}/-${c.removed}`).slice(0, 60),
        summary: act.summary.slice(0, 600),
      },
      [driftQuestion],
    );
    const p =
      r.status === 'answered' && r.answers[0]?.type === 'noul'
        ? r.answers[0].probability
        : undefined;
    if (p !== undefined && p <= CONFIDENT_FALSE) {
      evidence.push(
        'An advisory check suggests the last diff drifted away from the current task. Stay on the task.',
      );
      stuck.push('judge_drift');
      run.events.emit('judge.drift_flag', { task: task.id, probability: p });
    }
  }

  const verdict: PendingVerdict['verdict'] = reasons.length ? 'reject' : 'accept';
  const done = verdict === 'accept' && checksPass;
  const signature = verdict === 'reject' ? failureSignature(reasons) : '';
  run.events.emit('verify.result', {
    task: task.id,
    verdict,
    done,
    reasons,
    checks: checks.map((c) => ({ command: c.command, pass: c.pass })),
    diff: diffStats,
  });
  run.state.pending = {
    verdict,
    taskId: task.id,
    done,
    reasons,
    signature,
    diffHash: changes.length ? treeHash : '',
    ...(verdict === 'accept' && baseline ? { baseline } : {}),
    summary: act.summary,
    evidence: evidence.join('\n\n').slice(0, 8_000),
    changedFiles: changes.map((c) => c.path),
    diffStats,
    stuck,
    ...(testsPassed !== undefined ? { testsPassed } : {}),
    ...(act.worker ? { worker: act.worker } : {}),
  };
  await run.setPhase(verdict === 'accept' ? 'commit' : 'rollback');
}

function commitSubject(task: PlanNode): string {
  const title = task.title.replace(/\s+/g, ' ').trim();
  return `omnexx(${task.id}): ${title.length > 60 ? `${title.slice(0, 57)}...` : title}`;
}

/** COMMIT: idempotent. A commit for this cycle that already exists (crash after commit) is adopted. */
export async function stepCommit(run: Run): Promise<void> {
  const p = run.state.pending;
  if (!p) throw new StateError('commit phase without a pending verdict');
  const task = getNode(run.requirePlan(), p.taskId);
  const head = await headSha(run.worktree);
  let sha: string | undefined;
  if (head !== run.state.lastGreen) {
    const t = parseTrailers(await commitMessage(run.worktree, head));
    if (t?.run === run.state.runId && t.cycle === run.state.cycle) {
      sha = head;
      run.events.emit('reconcile.adopt', { sha: head });
    }
  }
  if (!sha && p.changedFiles.length && !(await isClean(run.worktree))) {
    const body = [
      p.summary.trim().slice(0, 1_500),
      `Gates passed${p.done ? '; task checks passed' : '; task not finished yet'}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    sha = await commitCheckpoint(run.worktree, commitSubject(task), body, {
      run: run.state.runId,
      task: task.id,
      cycle: run.state.cycle,
      ...(p.worker ? { worker: p.worker } : {}),
    });
  }
  if (sha) {
    run.state.lastGreen = sha;
    run.state.greenHistory.push({ sha, cycle: run.state.cycle });
    run.state.acceptedCommits++;
    if (p.baseline) run.state.baseline = p.baseline;
    run.events.emit('commit', {
      sha,
      task: task.id,
      done: p.done,
      diff: p.diffStats,
      worker: p.worker,
    });
    if (run.config.git.push === 'branch') {
      const r = await git(
        run.worktree,
        ['push', run.config.git.remote, `${run.state.branch}:${run.state.branch}`],
        { allowFailure: true },
      );
      run.events.emit(r.exitCode === 0 ? 'git.pushed' : 'git.push_failed', {
        branch: run.state.branch,
        error: r.exitCode ? r.stderr.split('\n')[0] : undefined,
      });
    }
  }
  run.state.lastProgressAt = run.clock.now();
  run.state.lastProgressCycle = run.state.cycle;
  await run.setPhase('record');
}

/** ROLLBACK: save the failed diff, reset to lastGreen. Idempotent. */
export async function stepRollback(run: Run): Promise<void> {
  const p = run.state.pending;
  const patch = join(
    run.store.dir,
    'rejected',
    `${run.state.cycle}${p?.worker ? `-${p.worker}` : ''}.patch`,
  );
  const { savedPatch } = await rollbackTo(run.worktree, run.state.lastGreen, {
    path: patch,
    redact: (x) => run.redactor.text(x),
  });
  run.state.rejectedCycles++;
  run.events.emit('rollback', {
    to: run.state.lastGreen,
    task: p?.taskId,
    reasons: p?.reasons ?? [],
    patch: savedPatch ? patch : undefined,
  });
  await run.setPhase('record');
}

/** RECORD: plan, progress journal and per-task memory. Skipped when this cycle was already recorded. */
export async function stepRecord(run: Run): Promise<void> {
  const p = run.state.pending;
  if (!p) throw new StateError('record phase without a pending verdict');
  const plan = run.requirePlan();
  const task = getNode(plan, p.taskId);
  const interrupted = p.reasons.length === 1 && p.reasons[0] === INTERRUPTED_BY_BUDGET;
  if (run.state.recordedCycle !== run.state.cycle && interrupted) {
    run.events.emit('cycle.recorded', {
      task: task.id,
      verdict: 'interrupted',
      attempts: task.attempts,
    });
    // Waiting on a budget cap isn't a lack of progress.
    run.state.lastProgressCycle = run.state.cycle;
    run.state.recordedCycle = run.state.cycle;
  } else if (run.state.recordedCycle !== run.state.cycle) {
    task.attempts++;
    if (p.verdict === 'accept') {
      task.consecutiveRejections = 0;
      if (p.done) {
        task.status = 'done';
        task.doneAtCycle = run.state.cycle;
        task.evidence = [];
      } else task.status = 'doing';
    } else {
      task.status = 'doing';
      task.consecutiveRejections++;
      task.failureSignatures = [...task.failureSignatures, p.signature].slice(-10);
      task.lastRejection = p.reasons.join('; ').slice(0, 500);
      const approach = p.summary
        .split('\n')
        .find((l) => l.trim())
        ?.trim()
        .slice(0, 200);
      if (approach && !task.approachesTried.includes(approach))
        task.approachesTried = [...task.approachesTried, approach].slice(-8);
      if (p.evidence)
        task.evidence = [
          ...task.evidence,
          `Cycle ${run.state.cycle} was rejected: ${p.reasons.join('; ')}\n${p.evidence}`,
        ].slice(-3);
      // Advisory similarity check: logged only.
      const prev = task.failureSignatures.at(-2);
      if (prev && run.judge.enabled('failure_similarity')) {
        const r = await run.judge.ask(
          'failure_similarity',
          { previous: prev.slice(0, 1_500), latest: p.signature.slice(0, 1_500) },
          [sameFailureQuestion],
        );
        if (r.status === 'answered' && r.answers[0]?.type === 'noul') {
          run.events.emit('judge.similarity', {
            task: task.id,
            sameRootCause: r.answers[0].probability,
            deterministicSame: prev === p.signature,
          });
        }
      }
    }
    await run.savePlan();
    const outcome =
      p.verdict === 'accept'
        ? p.done
          ? `accepted, ${task.id} done`
          : 'accepted (partial)'
        : `rejected: ${p.reasons.join('; ')}`;
    await run.store.appendProgress(
      run.state.cycle,
      [
        `Task ${task.id} (${task.title}), attempt ${task.attempts}: ${outcome}.`,
        p.verdict === 'accept'
          ? `Commit ${run.state.lastGreen.slice(0, 10)}. Files: ${p.changedFiles.slice(0, 12).join(', ') || 'none'}.`
          : '',
        p.summary
          ? `Agent summary: ${p.summary.split('\n').slice(0, 4).join(' ').slice(0, 400)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    if (p.verdict === 'accept' && p.changedFiles.length) await refreshCodemap(run, p.changedFiles);
    run.events.emit(p.done ? 'task.done' : 'cycle.recorded', {
      task: task.id,
      verdict: p.verdict,
      attempts: task.attempts,
    });
    run.state.recordedCycle = run.state.cycle;
  }
  run.state.act = undefined;
  await run.setPhase('guard');
}

/** One complete cycle on one task: ACT → VERIFY → COMMIT|ROLLBACK → RECORD (M1's unit of work). */
export async function runOneCycle(run: Run, taskId: string): Promise<PendingVerdict> {
  run.state.cycle++;
  await run.setPhase('act', { taskId, pending: undefined });
  run.events.emit('cycle.start', { task: taskId });
  await stepAct(run);
  await stepVerify(run);
  if (run.state.phase === 'commit') await stepCommit(run);
  else await stepRollback(run);
  const pending = run.state.pending;
  if (!pending) throw new StateError('cycle ended without a verdict');
  await stepRecord(run);
  run.events.emit('cycle.end', {
    task: taskId,
    verdict: pending.verdict,
    done: pending.done,
    usd: run.state.spend.usd,
  });
  return pending;
}
