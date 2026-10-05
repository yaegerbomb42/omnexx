import { readTextOr } from '../core/atomic.js';
import { renderNotes } from '../core/notes.js';
import { applyPlanUpdate, compactPlanView, planUpdateSchema, type Plan } from '../core/plan.js';
import type { Run } from '../core/run.js';
import { OmnexxError, StateError } from '../errors.js';
import { PathJail } from '../security/paths.js';
import { readOnlyTools, toolSpec } from '../tools/registry.js';
import { fail, ok, type Tool, type ToolContext } from '../tools/types.js';
import { renderCodemap, type Codemap } from './codemap.js';
import { runAgentLoop } from './loop.js';
import { PLANNER_SYSTEM } from './prompts.js';

/** The planner loop ended (caps, stop, refusal) before a valid plan was written. */
export class PlannerIncomplete extends StateError {
  constructor(readonly end: string) {
    super(`planner ended (${end}) without a valid plan`, 'see `omnexx logs` for what it tried');
  }
}

export type PlannerMode =
  | { kind: 'initial' }
  | { kind: 'expand'; milestoneId: string }
  | { kind: 'replan'; reason: string }
  | { kind: 'split'; taskId: string; reason: string };

function instruction(mode: PlannerMode, plan: Plan | undefined): string {
  if (mode.kind === 'initial')
    return 'There is no plan yet. Explore the repository, then call write_plan with milestones, expanding only the first one or two into tasks.';
  const view = plan ? compactPlanView(plan, undefined) : '';
  const full = plan
    ? JSON.stringify({
        milestones: plan.nodes
          .filter((n) => n.type === 'milestone')
          .map((m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            tasks: plan.nodes
              .filter((t) => t.parentId === m.id)
              .map((t) => ({ id: t.id, title: t.title, status: t.status })),
          })),
      })
    : '';
  if (mode.kind === 'expand') {
    return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nExpand milestone ${mode.milestoneId} into leaf tasks (ids ${mode.milestoneId}.T01, ...). Call write_plan with the complete plan: every existing milestone and task, plus the new tasks.`;
  }
  if (mode.kind === 'split') {
    const t = plan?.nodes.find((n) => n.id === mode.taskId);
    const evidence = t
      ? [...t.approachesTried.map((a) => `- tried: ${a}`), ...t.evidence.slice(-2)].join('\n')
      : '';
    return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nTask ${mode.taskId} is stuck: ${mode.reason}.\n${evidence}\n\nSplit ${mode.taskId} into 2-4 smaller tasks under the same milestone, with new ids that are not used yet, each with its own checks. Prefer a first task that writes a failing test reproducing the problem. The new tasks replace ${mode.taskId}; it will be marked done when they are. Call write_plan with the complete plan: every existing milestone and task, plus the new tasks.`;
  }
  return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nRe-plan because: ${mode.reason}. You may split, add or reorder nodes under the affected milestone, and park nodes with a reason. Never delete a node. Call write_plan with the complete plan.`;
}

/**
 * Cycle 0 and later expansions: the planner model with read-only tools plus `write_plan`.
 * The tool validates the plan (schema, ids, dependencies, no deletions) and the planner retries
 * until it is valid or the cycle's caps end the loop.
 */
export async function runPlanner(run: Run, mode: PlannerMode): Promise<Plan> {
  const goal = await run.store.readGoal();
  let written: Plan | undefined;
  const writePlan: Tool<typeof planUpdateSchema> = {
    name: 'write_plan',
    description:
      'Write the complete plan (milestones with optional tasks, plus nodes to park). Validated by the harness.',
    schema: planUpdateSchema,
    readOnly: true,
    run(input) {
      try {
        written = applyPlanUpdate(run.plan, input, goal.text.trim());
        return Promise.resolve(ok(`plan accepted: ${written.nodes.length} nodes`));
      } catch (err) {
        return Promise.resolve(
          fail(
            `plan rejected: ${err instanceof OmnexxError ? `${err.message}${err.hint ? ` (${err.hint})` : ''}` : (err as Error).message}`,
          ),
        );
      }
    },
  };
  const tools = [...(await readOnlyTools(run.config)), writePlan as Tool];
  const codemapText = await readTextOr(run.store.file('codemap.json'), '');
  const codemap = codemapText
    ? renderCodemap(JSON.parse(codemapText) as Codemap, run.config.context.repo_map_max_tokens)
    : '# Codebase map\n(not built)';
  const notes = renderNotes(await run.store.readNotes());
  let n = 0;
  const toolCtx: ToolContext = {
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
    nextCommandId: () => `cmd-plan${run.state.cycle}-${++n}`,
    edited: new Set(),
  };
  run.events.emit('planner.start', {
    mode: mode.kind,
    ...(mode.kind === 'expand' ? { milestone: mode.milestoneId } : {}),
  });
  const result = await runAgentLoop(
    {
      system: [
        { text: PLANNER_SYSTEM },
        { text: codemap },
        { text: `# Goal\n\n${goal.text.trim()}` },
        { text: `# Lessons (notes.md)\n\n${notes}`, cacheBreakpoint: true },
      ],
      first: { role: 'user', content: [{ type: 'text', text: instruction(mode, run.plan) }] },
      tools: tools.map(toolSpec),
    },
    {
      provider: run.deps.provider,
      models: (
        await run.router.pick({
          action: mode.kind === 'initial' || mode.kind === 'expand' ? 'plan' : mode.kind,
          needs: { tools: true },
          facts: { mode: mode.kind },
        })
      ).chain,
      providerBlocked: (p) => run.providerBlocked(p),
      coolProvider: (p, ms) => {
        run.coolProvider(p, ms);
      },
      tools,
      toolCtx,
      budget: run.config.budget,
      maxTokens: run.config.providers.anthropic.max_tokens,
      clock: run.clock,
      events: run.events,
      spentUsd: () => run.state.spend.usd,
      spentTodayUsd: () => run.spentToday(),
      onUsage: (u, usd, model, provider) => run.addSpend(u, usd, model, 'planner', provider),
      control: () => run.control(),
      signal: run.abort.signal,
    },
  );
  if (!written) {
    throw new PlannerIncomplete(result.end);
  }
  run.plan = written;
  await run.savePlan();
  run.events.emit('plan.written', {
    mode: mode.kind,
    nodes: written.nodes.length,
    turns: result.turns,
    usd: result.usd,
  });
  return written;
}
