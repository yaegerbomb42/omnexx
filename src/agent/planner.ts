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
import { subagentRunner } from './subagent.js';
import { PLANNER_SYSTEM } from './prompts.js';
import { readIntent, writeIntentTool } from './intent.js';
import type { RouteAction } from '../router/actions.js';

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
  | { kind: 'split'; taskId: string; reason: string }
  | { kind: 'beyond'; round: number; maxRounds: number };

/** The rubric beyond mode ranks improvements against, once the goal itself is met. */
export const BEYOND_RUBRIC = [
  'correctness hardening: error paths, input validation, edge cases the tests miss',
  'test coverage of untested behaviour that users depend on',
  'security: dependency audit, secrets, injection, unsafe defaults',
  'performance of hot paths, measured before and after',
  'developer experience: README, setup scripts, types, clear errors',
  'accessibility and UX polish when there is a UI (check it in a browser if one is available)',
  'observability: logs and errors that make failures diagnosable',
  'refactors that remove real duplication or risk, with tests green before and after',
];

function instruction(mode: PlannerMode, plan: Plan | undefined): string {
  if (mode.kind === 'initial')
    return 'There is no plan yet. Explore the repository. Then call write_intent with what the user actually wants (the goal may be one short sentence: infer the intended build from it and from the repo, and record your assumptions instead of asking). Then call write_plan with milestones, expanding only the first one or two into tasks. M1 is the shortest path to a working, checkable v1; widen and polish in later milestones.';
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
    return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nExpand milestone ${mode.milestoneId} into leaf tasks (ids ${mode.milestoneId}.T01, ...). Call write_plan with the milestone you changed (milestones and tasks you leave out are kept unchanged).`;
  }
  if (mode.kind === 'split') {
    const t = plan?.nodes.find((n) => n.id === mode.taskId);
    const evidence = t
      ? [...t.approachesTried.map((a) => `- tried: ${a}`), ...t.evidence.slice(-2)].join('\n')
      : '';
    return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nTask ${mode.taskId} is stuck: ${mode.reason}.\n${evidence}\n\nSplit ${mode.taskId} into 2-4 smaller tasks under the same milestone, with new ids that are not used yet, each with its own checks. Prefer a first task that writes a failing test reproducing the problem. The new tasks replace ${mode.taskId}; it will be marked done when they are. Call write_plan with the milestone you changed (milestones and tasks you leave out are kept unchanged).`;
  }
  if (mode.kind === 'beyond') {
    return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nThe goal is met: every milestone and task is done and its checks pass. This is improvement round ${mode.round} of at most ${mode.maxRounds}. Work like the best engineer on the team would after shipping: look at the code and pick the few improvements with the highest real value, ranked against:\n${BEYOND_RUBRIC.map((r) => `- ${r}`).join('\n')}\n\nAdd ONE new milestone with 2-6 tasks. Every task must add or tighten a check (a new test, a stricter lint or type rule, a benchmark threshold) so its value is verified, not claimed. No cosmetic churn, no rewrites for taste. If nothing clears that bar, call write_plan with the plan unchanged: that ends the run.`;
  }
  return `Current plan:\n${view}\n\nExisting ids (keep every one):\n${full}\n\nRe-plan because: ${mode.reason}. You may split, add or reorder nodes under the affected milestone, and park nodes with a reason. Never delete a node. Call write_plan with the milestones you changed (anything you leave out is kept unchanged).`;
}

/**
 * Cycle 0 and later expansions: the planner model with read-only tools plus `write_plan`.
 * The tool validates the plan (schema, ids, dependencies, no deletions) and the planner retries
 * until it is valid or the cycle's caps end the loop.
 */
/** The goal as written, plus the inferred intent once there is one. */
export function goalBlock(goal: string, intent: string): string {
  return intent ? `# Goal\n\n${goal.trim()}\n\n${intent}` : `# Goal\n\n${goal.trim()}`;
}

function plannerAction(mode: PlannerMode): RouteAction {
  switch (mode.kind) {
    case 'initial':
    case 'expand':
      return 'plan';
    case 'beyond':
      return 'beyond-ideate';
    default:
      return mode.kind;
  }
}

export async function runPlanner(run: Run, mode: PlannerMode): Promise<Plan> {
  const goal = await run.store.readGoal();
  const intent = await readIntent(run.store);
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
  if (mode.kind === 'initial') {
    tools.push(
      writeIntentTool(run.store, (i) => {
        run.events.emit('intent.update', {
          product: i.product.slice(0, 200),
          assumptions: i.assumptions.length,
        });
      }),
    );
  }
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
  toolCtx.subagent = subagentRunner(run, toolCtx);
  run.events.emit('planner.start', {
    mode: mode.kind,
    ...(mode.kind === 'expand' ? { milestone: mode.milestoneId } : {}),
  });
  const result = await runAgentLoop(
    {
      system: [
        { text: PLANNER_SYSTEM },
        { text: codemap },
        { text: goalBlock(goal.text, intent) },
        { text: `# Lessons (notes.md)\n\n${notes}`, cacheBreakpoint: true },
      ],
      first: { role: 'user', content: [{ type: 'text', text: instruction(mode, run.plan) }] },
      tools: tools.map(toolSpec),
    },
    {
      provider: run.deps.provider,
      models: (
        await run.router.pick({
          action: plannerAction(mode),
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
      parallelTasks: run.config.context.subagent_parallel,
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
