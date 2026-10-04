import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runArgv } from '../core/exec.js';
import { getNode } from '../core/plan.js';
import type { PendingVerdict } from '../core/run-store.js';
import type { Run } from '../core/run.js';
import {
  stepCommit,
  stepRecord,
  stepRollback,
  stepVerify,
  prepareWorktree,
} from '../core/cycle.js';
import { git } from '../git/git.js';
import { workingTreeDiff } from '../git/repo.js';
import { sanitizePatch } from '../git/rollback.js';
import { scrubEnv } from '../security/env-scrub.js';
import type { QuotaStore, Semaphore } from './quota.js';
import type { WorkerBackend, WorkerOutcome, WorkerTask } from './types.js';

/**
 * Push is disabled for the worker process through per-process git config: every push URL is
 * rewritten to a scheme that can't connect, and origin's pushurl points nowhere.
 */
export const PUSH_DISABLED_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'url.omnexx-push-disabled://.pushInsteadOf',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
  GIT_CONFIG_VALUE_1: 'omnexx-push-disabled://nowhere',
};

async function refs(repo: string): Promise<Map<string, string>> {
  const out = (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );
}

function refDiff(before: Map<string, string>, after: Map<string, string>, own: string): string[] {
  const changed: string[] = [];
  for (const [ref, sha] of after) if (ref !== own && before.get(ref) !== sha) changed.push(ref);
  for (const ref of before.keys())
    if (ref !== own && !after.has(ref)) changed.push(`${ref} (deleted)`);
  return changed;
}

function prompt(task: WorkerTask): string {
  return [
    `Task ${task.id}: ${task.title}`,
    task.acceptance.length ? `Acceptance:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
    task.checks.length
      ? `These commands must pass afterwards:\n${task.checks.map((c) => `- ${c}`).join('\n')}`
      : '',
    task.evidence.length ? `Earlier attempts failed:\n${task.evidence.join('\n\n')}` : '',
    'Make the smallest change that does this. Do not delete or skip tests. Do not push.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type WorkerCycleResult =
  | { ran: false; reason: string }
  | { ran: true; outcome: WorkerOutcome; verdict: PendingVerdict['verdict']; tampered: string[] };

/**
 * One cycle on one task, done by a worker backend instead of the native loop. The worker's
 * result is only a candidate diff: it goes through the same VERIFY → COMMIT|ROLLBACK → RECORD
 * steps as a native cycle, and commits carry an `Omnexx-Worker` trailer.
 */
export async function runWorkerCycle(
  run: Run,
  backend: WorkerBackend,
  taskId: string,
  deps: { quota: QuotaStore; semaphore: Semaphore },
): Promise<WorkerCycleResult> {
  if (run.state.disabledWorkers.includes(backend.id))
    return { ran: false, reason: 'disabled for this run' };
  const blocked = await deps.quota.blocked(backend.id, backend.quota, run.clock.now());
  if (blocked) {
    run.events.emit('worker.skipped', { worker: backend.id, reason: blocked });
    return { ran: false, reason: blocked };
  }
  const release = await deps.semaphore.acquire();
  const task = getNode(run.requirePlan(), taskId);
  run.state.cycle++;
  await run.setPhase('act', { taskId, pending: undefined, act: undefined });
  run.events.emit('cycle.start', { task: taskId, worker: backend.id });
  await prepareWorktree(run);

  const label = `${backend.id}-${run.state.cycle}`;
  const wtPath = join(run.deps.paths.home, 'worktrees', `${run.state.runId}-w-${label}`);
  const branch = `omnexx/${run.state.runId}-w-${label}`;
  const repo = run.state.repoRoot;
  let outcome: WorkerOutcome;
  let tampered: string[];
  try {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, wtPath, run.state.lastGreen]);
    const before = await refs(repo);
    const text = prompt({
      id: task.id,
      title: task.title,
      acceptance: task.acceptance,
      checks: task.checks,
      evidence: task.evidence,
    });
    const promptFile = join(run.store.dir, `worker-${label}.prompt.md`);
    await writeFile(promptFile, run.redactor.text(text), { mode: 0o600 });
    const inv = backend.buildInvocation(
      {
        id: task.id,
        title: task.title,
        acceptance: task.acceptance,
        checks: task.checks,
        evidence: task.evidence,
      },
      { worktree: wtPath, promptFile, prompt: text },
    );
    // HOME is kept so the tool finds its own config; supervisor secrets never pass.
    const env = scrubEnv(run.deps.env, {
      passthrough: run.config.policy.env_passthrough,
      set: { ...inv.env, ...PUSH_DISABLED_ENV, TMPDIR: run.tmpDir },
    });
    await mkdir(run.store.logsDir, { recursive: true });
    const stdoutPath = join(run.store.logsDir, `worker-${label}.stdout.log`);
    const stderrPath = join(run.store.logsDir, `worker-${label}.stderr.log`);
    const r = await runArgv(inv.argv, {
      cwd: wtPath,
      env,
      timeoutMs: backend.timeoutMs,
      killGraceMs: 1_000,
      ...(inv.stdin !== undefined ? { stdin: inv.stdin } : {}),
      redact: (s) => run.redactor.text(s),
      stdoutPath,
      stderrPath,
    });
    await writeFile(
      join(run.store.logsDir, `worker-${label}.log`),
      `$ ${inv.argv.join(' ')}\n[exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}, ${r.durationMs}ms]\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n`,
      { mode: 0o600 },
    );
    outcome = r.timedOut
      ? { status: 'timeout' }
      : await backend.parseResult(r.exitCode, stdoutPath, stderrPath);
    tampered = refDiff(before, await refs(repo), `refs/heads/${branch}`);
    await deps.quota.record(backend.id, outcome.status, backend.quota, run.clock.now());

    if (tampered.length) {
      run.state.disabledWorkers.push(backend.id);
      run.events.emit('worker.tamper', { worker: backend.id, refs: tampered });
    } else if (outcome.status === 'completed') {
      // Flatten whatever the worker did (commits plus uncommitted work) into one candidate diff.
      const { patch } = await workingTreeDiff(wtPath, run.state.lastGreen);
      const clean = sanitizePatch(patch, (s) => s);
      if (clean.trim()) {
        const applied = await git(run.worktree, ['apply', '--binary', '--whitespace=nowarn', '-'], {
          input: clean,
          allowFailure: true,
        });
        if (applied.exitCode !== 0)
          run.events.emit('worker.apply_failed', {
            worker: backend.id,
            error: applied.stderr.split('\n')[0],
          });
      }
    }
  } finally {
    await git(repo, ['worktree', 'remove', '--force', wtPath], { allowFailure: true });
    await git(repo, ['branch', '-D', branch], { allowFailure: true });
    await rm(wtPath, { recursive: true, force: true });
    release();
  }
  run.events.emit('worker.result', {
    worker: backend.id,
    task: taskId,
    outcome: outcome.status,
    tampered: tampered.length > 0,
  });

  const summary = outcome.summary
    ? run.redactor.text(outcome.summary).slice(0, 2_000)
    : `${backend.displayName}: ${outcome.status}`;
  run.state.act = {
    summary,
    end: `worker:${outcome.status}`,
    turns: 0,
    usd: 0,
    worker: backend.id,
  };
  await run.setPhase('verify');
  await stepVerify(run);
  const pending = run.state.pending;
  if (pending && (tampered.length || outcome.status !== 'completed')) {
    pending.verdict = 'reject';
    pending.done = false;
    pending.reasons = [
      ...pending.reasons,
      tampered.length
        ? `worker ${backend.id} changed refs outside its worktree: ${tampered.join(', ')}`
        : `worker ${backend.id}: ${outcome.status}`,
    ];
    await run.setPhase('rollback');
  }
  if (run.state.phase === 'commit') await stepCommit(run);
  else await stepRollback(run);
  const verdict = run.state.pending?.verdict ?? 'reject';
  await stepRecord(run);
  await run.setPhase('select', { pending: undefined });
  return { ran: true, outcome, verdict, tampered };
}
