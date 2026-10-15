import { withoutVendored } from '../agent/codemap.js';
import { runAgentLoop, type LoopDeps, type LoopResult } from '../agent/loop.js';
import { plannerCandidates } from '../agent/planner.js';
import { git } from '../git/git.js';
import { workingTreeDiff } from '../git/repo.js';
import { rollbackTo } from '../git/rollback.js';
import type { ResolvedModel } from '../providers/pricing.js';
import type { SystemBlock, ToolSpec } from '../providers/types.js';
import { blocking, renderFindings, reviewChange } from '../verify/review.js';
import type { GateResult } from '../verify/gates.js';
import type { judgeGate } from '../verify/ratchet.js';
import { FAST_TASK } from './fast-path.js';
import { fixNote } from './fix-memory.js';
import { mergeNotes } from './repo-memory.js';
import type { PlanNode } from './plan.js';
import type { Run } from './run.js';
import { checkTree, type CheckSession, type TaskCheck } from './think-loop-check.js';
import { runThinkLoop, type ChainKind, type SessionIO, type SessionResult } from './think-loop.js';

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
  runChecks: () => Promise<TaskCheck[]>;
}

/** Restore the worktree to a tree a check passed on (lastGreen plus that tree's changes). */
async function restoreTree(run: Run, tree: string): Promise<void> {
  await rollbackTo(run.worktree, run.state.lastGreen);
  await git(run.worktree, ['read-tree', '-u', '--reset', tree]);
  await git(run.worktree, ['reset', '-q']);
}

/** Record (failure signature -> what fixed it) in the run's lessons, folded into repo memory. */
async function rememberFix(run: Run, signature: string, summary: string): Promise<void> {
  if (!summary.trim()) return;
  try {
    const today = new Date(run.clock.now()).toISOString().slice(0, 10);
    const notes = await run.store.readNotes();
    const next = mergeNotes(
      notes,
      [fixNote(signature, summary, today)],
      run.config.context.notes_max_tokens,
    );
    await run.store.writeNotes(next);
    run.events.emit('memory.fix_saved', { signature: signature.slice(0, 120) });
  } catch (err) {
    run.events.emit('memory.save_failed', { error: (err as Error).message });
  }
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
  const session: CheckSession = { quarantined: new Set(), persistent: new Set() };
  const io: SessionIO = {
    segment: (s, chain) => {
      // Thinking reads without editing by design: the no-edit stuck watch would cut it short.
      const { watch, ...base } = inputs.deps(chains[chain]);
      const rest =
        s.maxTurns === undefined
          ? base
          : {
              ...base,
              budget: {
                ...base.budget,
                max_turns_per_cycle: Math.min(s.maxTurns, base.budget.max_turns_per_cycle),
              },
            };
      return runAgentLoop(
        { ...inputs.ctx, history: s.history, first: s.first, anchor: s.anchor },
        chain === 'think' || !watch ? rest : { ...rest, watch },
      );
    },
    check: () => checkTree(run, task, inputs.runChecks, session, ++round),
    onFixed: (signature, summary) => rememberFix(run, signature, summary),
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
    thinkTurns: run.config.plan.loop_think_turns,
    rewinds: run.config.plan.loop_rewinds,
  });
}
