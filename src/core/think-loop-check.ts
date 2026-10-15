import { workingTreeDiff } from '../git/repo.js';
import { antiCheat } from '../verify/anticheat.js';
import { runGatesWithFlakyCheck } from '../verify/flaky.js';
import type { GateResult } from '../verify/gates.js';
import { failureSignature, judgeGate } from '../verify/ratchet.js';
import { classify, renderTriage } from '../verify/triage.js';
import type { PassState } from './doom-breaker.js';
import { FAST_TASK } from './fast-path.js';
import { recallFix } from './fix-memory.js';
import { mergeNotes, readRepoNotes } from './repo-memory.js';
import type { Note } from './notes.js';
import type { PlanNode } from './plan.js';
import type { Run } from './run.js';
import type { CheckOutcome } from './think-loop.js';

/** Failure text sent back to the agent, at most this many chars. */
const FAILURE_CHARS = 6_000;
/** Task-check output kept per failing check (the rest via read_log). */
const CHECK_OUTPUT_CHARS = 1_500;

/** Per-session state the checks keep between rounds. */
export interface CheckSession {
  /** Failure ids that failed and passed on a re-run: quarantined for the rest of the run. */
  quarantined: Set<string>;
  /** Failure ids that persisted through a re-run: real, not re-run again. */
  persistent: Set<string>;
}

export interface TaskCheck {
  command: string;
  pass: boolean;
  output: string;
}

/** Drop quarantined (flaky) failures before judging; a gate left with none of its own passes. */
export function withoutQuarantined(r: GateResult, quarantined: ReadonlySet<string>): GateResult {
  const failures = r.failures.filter((f) => !quarantined.has(f.id));
  if (failures.length === r.failures.length) return r;
  const onlyFlaky = r.structured && !r.timedOut && failures.length === 0;
  return { ...r, failures, ...(onlyFlaky ? { exitCode: 0 } : {}) };
}

const diffLines = (patch: string): number =>
  patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;

const DIAGNOSTIC_ID = /:TS\d+|:[a-z-]+\/[a-z-]+|lint|tsc|typecheck/i;

/** The repo's lessons plus this run's, for recalling fixes; empty when unreadable. */
export async function knownNotes(run: Run): Promise<Note[]> {
  try {
    const repo = await readRepoNotes(run.deps.paths, run.state.repoRoot);
    return mergeNotes(repo, await run.store.readNotes(), Number.MAX_SAFE_INTEGER);
  } catch (err) {
    run.events.emit('memory.read_failed', { error: (err as Error).message });
    return [];
  }
}

/**
 * The checks one round ends with: every gate against the baseline (re-running new failures to
 * catch flakes), anti-cheat, then the task's checks. Failures go back triaged, not as raw logs.
 */
export async function checkTree(
  run: Run,
  task: PlanNode,
  runChecks: () => Promise<TaskCheck[]>,
  session: CheckSession,
  round: number,
): Promise<CheckOutcome> {
  const { changes, patch, treeHash } = await workingTreeDiff(run.worktree, run.state.lastGreen);
  const failures: string[] = [];
  const reasons: string[] = [];
  // The fast path's checks are the gates, which pass before any work: it must change something.
  if (task.id === FAST_TASK && !changes.length) {
    reasons.push('no changes');
    failures.push('Nothing has changed yet: the goal is not done. Make the changes it asks for.');
  }
  const reruns = run.config.plan.loop_flaky_reruns;
  const { results: raw, flaky } = await runGatesWithFlakyCheck(
    run.config.gates.map((g) => ({ ...g, flaky_reruns: reruns })),
    {
      exec: run.exec,
      cwd: run.worktree,
      env: run.childEnv,
      logsDir: run.store.logsDir,
      label: `c${run.state.cycle}-loop${round}`,
      maxCmdTimeoutMs: run.maxCmdTimeoutMs,
      redact: (s) => run.redactor.text(s),
      signal: run.signal,
    },
    run.state.baseline,
    session.persistent,
  );
  for (const f of flaky) for (const id of f.ids) session.quarantined.add(id);
  if (reruns > 0) for (const r of raw) for (const f of r.failures) session.persistent.add(f.id);
  if (flaky.length) run.events.emit('loop.flaky', { task: task.id, flaky });
  const results = raw.map((r) => withoutQuarantined(r, session.quarantined));
  const verdicts = results.map((r) => judgeGate(r, run.state.baseline));
  for (const v of verdicts) if (!v.pass) reasons.push(`gate ${v.gate}: ${v.reason ?? 'failed'}`);
  const triageInput = {
    results: raw,
    verdicts,
    baseline: run.state.baseline,
    flaky: session.quarantined,
    patch,
  };
  const triaged = classify(triageInput);
  const gateText = renderTriage(triaged, triageInput);
  if (verdicts.some((v) => !v.pass) || triaged.some((t) => t.kind === 'env'))
    failures.push(gateText);
  // The cycle's verify rejects these whatever the tests say: catch them here, while the agent
  // can still fix them (bench hard10 task-04 lost a green session to a `# noqa` in a scratch file).
  for (const v of antiCheat({
    changes,
    patch,
    protectedPatterns: run.config.protected,
    allow: task.allow,
    baseline: run.state.baseline,
    results,
  })) {
    reasons.push(`anti-cheat ${v.rule}`);
    failures.push(
      `Would be rejected by anti-cheat (${v.rule}): ${v.detail}. Undo that; fix the cause instead.`,
    );
  }
  for (const c of await runChecks())
    if (!c.pass) {
      reasons.push(`check ${c.command}`);
      failures.push(`Check failed: \`${c.command}\`\n${c.output.slice(-CHECK_OUTPUT_CHARS)}`);
    }
  const live = triaged.filter((t) => t.kind === 'real' || t.kind === 'env');
  const failIds = [...live.map((t) => t.failure.id), ...reasons];
  const signature = reasons.length
    ? failureSignature([...reasons, ...live.map((t) => t.failure.id)])
    : '';
  if (signature) {
    const fix = recallFix(await knownNotes(run), signature);
    if (fix) failures.push(`From this repo's memory: ${fix}`);
  }
  const state: PassState = {
    passed: results.reduce((n, r) => n + (r.tests?.passed ?? 0), 0),
    failingChecks: reasons.length,
    failIds,
    diagnostics: live.filter((t) => DIAGNOSTIC_ID.test(t.failure.id)).length,
    diffSize: diffLines(patch),
  };
  return {
    pass: reasons.length === 0,
    failures: failures.join('\n\n').slice(0, FAILURE_CHARS),
    signature,
    tree: treeHash,
    state,
  };
}
