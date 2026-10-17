import type { GateConfig } from '../config/schema.js';
import { workingTreeDiff } from '../git/repo.js';
import { antiCheat } from '../verify/anticheat.js';
import { runGatesWithFlakyCheck } from '../verify/flaky.js';
import {
  readCrates,
  readScripts,
  relatedGate,
  relatedGreen,
  relatedRed,
} from '../verify/related-tests.js';
import type { GateResult, GateRunContext } from '../verify/gates.js';
import { failureSignature, judgeGate } from '../verify/ratchet.js';
import type { SpeculativeChecks } from '../verify/speculative.js';
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
  /** Gate runs started in the background after edits; reused only for the exact same tree. */
  speculative?: SpeculativeChecks;
  /** Tests each gate passed on its last full run, to score rounds checked on related tests. */
  fullPassed: Map<string, number>;
}

/**
 * Gates narrowed to the tests related to what changed since the last green commit, by name;
 * empty when `[plan] loop_related_tests` is off or nothing narrows.
 */
export async function relatedGates(
  run: Run,
  gates: readonly GateConfig[],
  files: readonly string[],
): Promise<Map<string, GateConfig>> {
  const out = new Map<string, GateConfig>();
  if (!run.config.plan.loop_related_tests || !files.length) return out;
  const [scripts, crates] = await Promise.all([
    readScripts(run.worktree),
    readCrates(run.worktree, files),
  ]);
  for (const g of gates) {
    const narrowed = relatedGate(g, files, scripts, crates);
    if (narrowed) out.set(g.name, narrowed);
  }
  return out;
}

/** Whether a pass with narrowed gates settles the check red: a narrowed or full gate is red. */
export const settlesRed = (
  results: readonly GateResult[],
  related: ReadonlyMap<string, GateConfig>,
  baseline: Run['state']['baseline'],
): boolean =>
  results.some((r) =>
    related.has(r.name) ? relatedRed(r, baseline) : !judgeGate(r, baseline).pass,
  );

/**
 * A red narrowed pass as reported: narrowed gates tagged, and the ones that settled nothing
 * (no tests found, unreadable output) left out, since their output isn't the suite's.
 */
export const asNarrowed = (
  results: readonly GateResult[],
  related: ReadonlyMap<string, GateConfig>,
  baseline: Run['state']['baseline'],
): GateResult[] =>
  results.flatMap((r) =>
    !related.has(r.name)
      ? [r]
      : relatedRed(r, baseline) || relatedGreen(r)
        ? [{ ...r, narrowed: true }]
        : [],
  );

/**
 * A narrowed run's pass count read as the whole gate's: the last full count (or the
 * baseline's) less what failed here, so the doom-breaker doesn't see a subset as a regression.
 */
function estimatePassed(r: GateResult, session: CheckSession, run: Run): number {
  const full = session.fullPassed.get(r.name) ?? run.state.baseline?.[r.name]?.tests?.passed;
  if (full === undefined) return r.tests?.passed ?? 0;
  return Math.max(0, full - (r.tests?.failed ?? r.failures.length));
}

/** Where and how the loop's gates run; `label` names their log files. */
export const gateContext = (run: Run, label: string): GateRunContext => ({
  exec: run.exec,
  cwd: run.worktree,
  env: run.childEnv,
  logsDir: run.store.logsDir,
  label,
  maxCmdTimeoutMs: run.maxCmdTimeoutMs,
  redact: (s) => run.redactor.text(s),
  signal: run.signal,
});

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
  const early = await session.speculative?.take(treeHash);
  const gatesStart = Date.now();
  const gates = run.config.gates.map((g) => ({ ...g, flaky_reruns: reruns }));
  const label = `c${run.state.cycle}-loop${round}`;
  const baseline = run.state.baseline;
  // A background run either settled red on related tests or ran the full gates for this tree.
  const earlyNarrowed = early?.results.some((r) => r.narrowed) ?? false;
  const related =
    early && !earlyNarrowed
      ? new Map<string, GateConfig>()
      : await relatedGates(
          run,
          gates,
          changes.filter((c) => c.status !== 'D').map((c) => c.path),
        );
  // Related tests first: a red there is the answer for this round (flakes re-run on the same
  // narrowed command). Otherwise the full gates run, so a check only comes back green on the
  // whole suite.
  const inner = related.size
    ? await runGatesWithFlakyCheck(
        gates.map((g) => related.get(g.name) ?? g),
        gateContext(run, `${label}-related`),
        baseline,
        session.persistent,
        new Map(earlyNarrowed ? early?.results.map((r) => [r.name, r] as const) : []),
      )
    : undefined;
  const innerRed = inner ? settlesRed(inner.results, related, baseline) : false;
  const firstRuns = new Map<string, GateResult>(
    inner
      ? inner.results.filter((r) => !related.has(r.name)).map((r) => [r.name, r])
      : (early?.results.map((r) => [r.name, r]) ?? []),
  );
  const gateRun =
    inner && innerRed
      ? { ...inner, results: asNarrowed(inner.results, related, baseline) }
      : await runGatesWithFlakyCheck(
          gates,
          gateContext(run, label),
          baseline,
          session.persistent,
          firstRuns,
        );
  const { results: raw, flaky } = gateRun;
  const narrowed = new Set(raw.filter((r) => r.narrowed).map((r) => r.name));
  if (!narrowed.size)
    for (const r of raw) if (r.tests) session.fullPassed.set(r.name, r.tests.passed);
  run.events.emit('loop.gates', {
    task: task.id,
    round,
    ms: Date.now() - gatesStart,
    reruns: gateRun.reruns + (inner && !innerRed ? inner.reruns : 0),
    speculative: early?.results.length ?? 0,
    settled: narrowed.size ? 'related' : 'full',
    ...(related.size ? { related: [...related.keys()] } : {}),
  });
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
    passed: results.reduce(
      (n, r) =>
        n + (narrowed.has(r.name) ? estimatePassed(r, session, run) : (r.tests?.passed ?? 0)),
      0,
    ),
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
