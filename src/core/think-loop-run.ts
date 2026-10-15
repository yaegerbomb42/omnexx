import { withoutVendored } from '../agent/codemap.js';
import { runAgentLoop, type LoopDeps, type LoopResult } from '../agent/loop.js';
import { plannerCandidates } from '../agent/planner.js';
import { git } from '../git/git.js';
import { workingTreeDiff } from '../git/repo.js';
import { rollbackTo } from '../git/rollback.js';
import type { ResolvedModel } from '../providers/pricing.js';
import type { SystemBlock, ToolSpec } from '../providers/types.js';
import { blocking, renderFindings, reviewChange } from '../verify/review.js';
import { runGates, type GateResult } from '../verify/gates.js';
import { failureSignature, judgeGate } from '../verify/ratchet.js';
import { FAST_TASK } from './fast-path.js';
import type { PlanNode } from './plan.js';
import type { Run } from './run.js';
import {
  runThinkLoop,
  type CheckOutcome,
  type ChainKind,
  type SessionIO,
  type SessionResult,
} from './think-loop.js';

/** Failure text sent back to the agent, at most this many chars. */
const FAILURE_CHARS = 6_000;

/** Whether this task runs as a think-loop session under `[plan] loop`. */
export function usesThinkLoop(run: Run, task: PlanNode): boolean {
  const mode = run.config.plan.loop;
  if (mode === 'off' || run.state.writing) return false;
  if (task.id === FAST_TASK && run.state.fastPath === 'tried') return true;
  return mode === 'all';
}

/** Failing gates (new failures against the baseline), as text for the agent. */
export function renderGateFailures(
  results: readonly GateResult[],
  verdicts: readonly ReturnType<typeof judgeGate>[],
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

export interface ThinkLoopInputs {
  ctx: { system: SystemBlock[]; first: LoopResult['messages'][number]; tools: ToolSpec[] };
  /** The cycle's loop dependencies for a model chain (a fresh stuck watch each call). */
  deps: (models: readonly ResolvedModel[]) => LoopDeps;
  workChain: readonly ResolvedModel[];
  /** The task's own checks, run in the worktree. */
  runChecks: () => Promise<{ command: string; pass: boolean; output: string }[]>;
}

/** The checks one round ends with: every gate against the baseline, then the task's checks. */
async function checkTree(run: Run, task: PlanNode, inputs: ThinkLoopInputs, round: number) {
  const { changes, treeHash } = await workingTreeDiff(run.worktree, run.state.lastGreen);
  const failures: string[] = [];
  const reasons: string[] = [];
  // The fast path's checks are the gates, which pass before any work: it must change something.
  if (task.id === FAST_TASK && !changes.length) {
    reasons.push('no changes');
    failures.push('Nothing has changed yet: the goal is not done. Make the changes it asks for.');
  }
  const results = await runGates(run.config.gates, {
    exec: run.exec,
    cwd: run.worktree,
    env: run.childEnv,
    logsDir: run.store.logsDir,
    label: `c${run.state.cycle}-loop${round}`,
    maxCmdTimeoutMs: run.maxCmdTimeoutMs,
    redact: (s) => run.redactor.text(s),
    signal: run.signal,
  });
  const verdicts = results.map((r) => judgeGate(r, run.state.baseline));
  for (const v of verdicts) if (!v.pass) reasons.push(`gate ${v.gate}: ${v.reason ?? 'failed'}`);
  const gateText = renderGateFailures(results, verdicts);
  if (gateText) failures.push(gateText);
  for (const c of await inputs.runChecks())
    if (!c.pass) {
      reasons.push(`check ${c.command}`);
      failures.push(`Check failed: \`${c.command}\`\n${c.output}`);
    }
  const out: CheckOutcome = {
    pass: reasons.length === 0,
    failures: failures.join('\n\n').slice(0, FAILURE_CHARS),
    signature: reasons.length ? failureSignature([...reasons, gateText]) : '',
    tree: treeHash,
  };
  return out;
}

/** Restore the worktree to a tree a check passed on (lastGreen plus that tree's changes). */
async function restoreTree(run: Run, tree: string): Promise<void> {
  await rollbackTo(run.worktree, run.state.lastGreen);
  await git(run.worktree, ['read-tree', '-u', '--reset', tree]);
  await git(run.worktree, ['reset', '-q']);
}

/** The end review: the whole diff against the goal and the agent's analysis. */
async function reviewDiff(run: Run, task: PlanNode, analysis: string): Promise<string | undefined> {
  const goal = (await run.store.readGoal()).text;
  const { patch } = await workingTreeDiff(run.worktree, run.state.lastGreen);
  const withAnalysis = analysis
    ? `${goal}\n\n# The agent's analysis (what it set out to do)\n${analysis.slice(0, 4_000)}`
    : goal;
  const r = await reviewChange(run, task, withAnalysis, withoutVendored(patch));
  if (!r) return undefined;
  const block = blocking(r.findings, run.config.review.block_on);
  run.events.emit('review.result', {
    task: task.id,
    findings: r.findings.length,
    blocking: block.length,
    summary: r.summary.slice(0, 200),
    loop: true,
  });
  return block.length ? renderFindings(block) : undefined;
}

/** Run the task as one think-first loop session, wired to the run's models, gates and git. */
export async function actAsThinkLoop(
  run: Run,
  task: PlanNode,
  inputs: ThinkLoopInputs,
): Promise<SessionResult> {
  const chains: Record<ChainKind, readonly ResolvedModel[]> = {
    think: plannerCandidates(run, run.chains.planner),
    work: inputs.workChain,
  };
  let round = 0;
  const io: SessionIO = {
    segment: (s, chain) => {
      // Thinking reads without editing by design: the no-edit stuck watch would cut it short.
      const { watch, ...rest } = inputs.deps(chains[chain]);
      return runAgentLoop(
        { ...inputs.ctx, history: s.history, first: s.first, anchor: s.anchor },
        chain === 'think' || !watch ? rest : { ...rest, watch },
      );
    },
    check: () => checkTree(run, task, inputs, ++round),
    ...(run.config.review.enabled
      ? { review: (analysis: string) => reviewDiff(run, task, analysis) }
      : {}),
    restore: (tree) => restoreTree(run, tree),
    emit: (type, data) => {
      run.events.emit(type, { task: task.id, ...data });
    },
  };
  return runThinkLoop(inputs.ctx.first, io, {
    rounds: run.config.plan.loop_rounds,
    rethinks: run.config.plan.loop_rethinks,
  });
}
