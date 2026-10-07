import { z } from 'zod';
import { StateError } from '../errors.js';

/**
 * The hierarchical plan (plan §14.1): goal → milestones → leaf tasks. Cycles execute leaf tasks.
 * Nodes are never deleted, only parked. The planner writes it through a schema-validated tool.
 */

export const TASK_KINDS = [
  'feature',
  'tests',
  'lint',
  'refactor',
  'migration',
  'docs',
  'investigate',
] as const;
export const NODE_STATUS = ['todo', 'doing', 'done', 'parked'] as const;
export type NodeStatus = (typeof NODE_STATUS)[number];

const id = z.string().regex(/^M\d+(\.T\d+)?$/, 'ids look like "M2" (milestone) or "M2.T07" (task)');

export const nodeInputSchema = z.strictObject({
  id,
  title: z.string().min(3).max(200),
  why: z.string().max(1_000).default(''),
  acceptance: z.array(z.string().max(500)).max(20).default([]),
  /** Shell commands the harness runs to decide "done". Exit 0 = pass. */
  checks: z.array(z.string().min(1).max(500)).max(10).default([]),
  dependsOn: z.array(id).default([]),
  size: z.enum(['S', 'M', 'L']).default('M'),
  kind: z.enum(TASK_KINDS).default('feature'),
  steps: z.array(z.string().max(300)).max(15).default([]),
  /** Lets one task delete tests, add skips, rewrite snapshots or touch protected paths. */
  allow: z.array(z.string()).default([]),
});
export type PlanNodeInput = z.input<typeof nodeInputSchema>;

export const planNodeSchema = nodeInputSchema.extend({
  type: z.enum(['milestone', 'task']),
  parentId: z.string().nullable(),
  status: z.enum(NODE_STATUS).default('todo'),
  attempts: z.number().int().nonnegative().default(0),
  consecutiveRejections: z.number().int().nonnegative().default(0),
  approachesTried: z.array(z.string()).default([]),
  failureSignatures: z.array(z.string()).default([]),
  lastRejection: z.string().optional(),
  parkedReason: z.string().optional(),
  /** Index into the strategy ladder for this task. */
  rung: z.number().int().nonnegative().default(0),
  /** Cycles on this task use the planner (strong) model instead of the worker model. */
  escalated: z.boolean().default(false),
  /** `attempts` when the task reached its current ladder rung (cycles-per-task counts from here). */
  rungStartedAt: z.number().int().nonnegative().default(0),
  /** Set when the ladder split this task: it is done once all of these are done. */
  splitInto: z.array(z.string()).default([]),
  doneAtCycle: z.number().int().optional(),
  evidence: z.array(z.string()).default([]),
});
export type PlanNode = z.infer<typeof planNodeSchema>;

export const planSchema = z.strictObject({
  version: z.literal(1),
  goal: z.string(),
  nodes: z.array(planNodeSchema),
});
export type Plan = z.infer<typeof planSchema>;

/** What the planner's `write_plan` tool accepts: milestones, each optionally expanded into tasks. */
export const planUpdateSchema = z.strictObject({
  milestones: z
    .array(
      nodeInputSchema.extend({
        id: z.string().regex(/^M\d+$/, 'milestone ids look like "M1"'),
        tasks: z
          .array(nodeInputSchema.extend({ id: z.string().regex(/^M\d+\.T\d+$/) }))
          .max(60)
          .default([]),
      }),
    )
    .min(1)
    .max(40),
  park: z.array(z.strictObject({ id, reason: z.string().min(3) })).default([]),
});
export type PlanUpdate = z.input<typeof planUpdateSchema>;

export const isTask = (n: PlanNode): boolean => n.type === 'task';

export function getNode(plan: Plan, nodeId: string): PlanNode {
  const n = plan.nodes.find((x) => x.id === nodeId);
  if (!n) throw new StateError(`plan has no node ${nodeId}`);
  return n;
}

export const milestones = (plan: Plan): PlanNode[] =>
  plan.nodes.filter((n) => n.type === 'milestone');
export const childrenOf = (plan: Plan, mId: string): PlanNode[] =>
  plan.nodes.filter((n) => n.parentId === mId);

/**
 * Merge a planner update into the plan. Existing nodes keep their runtime fields (status,
 * attempts, approaches); new nodes are appended; a node missing from the update is an error
 * because nodes are never deleted. Parking requires a reason.
 */
export function applyPlanUpdate(prev: Plan | undefined, update: PlanUpdate, goal: string): Plan {
  const parsed = planUpdateSchema.parse(update);
  const byId = new Map((prev?.nodes ?? []).map((n) => [n.id, n]));
  const seen = new Set<string>();
  const nodes: PlanNode[] = [];
  for (const m of parsed.milestones) {
    const { tasks, ...mi } = m;
    for (const node of [
      { ...mi, type: 'milestone' as const, parentId: null },
      ...tasks.map((t) => ({ ...t, type: 'task' as const, parentId: m.id })),
    ]) {
      if (seen.has(node.id)) throw new StateError(`duplicate plan id ${node.id}`);
      if (node.type === 'task' && !node.id.startsWith(`${m.id}.`)) {
        throw new StateError(`task ${node.id} must live under milestone ${m.id}`);
      }
      seen.add(node.id);
      const old = byId.get(node.id);
      nodes.push(
        old
          ? planNodeSchema.parse({ ...old, ...node, status: old.status, attempts: old.attempts })
          : planNodeSchema.parse(node),
      );
    }
  }
  // Nodes are never deleted. Anything the update leaves out stays as it was, where it was, so a
  // model can send just the milestone it changed (weaker models rarely restate the whole plan).
  for (const old of prev?.nodes ?? []) {
    if (seen.has(old.id)) continue;
    seen.add(old.id);
    const blockEnd = (milestoneId: string): number => {
      let at = nodes.findIndex((n) => n.id === milestoneId);
      while (at + 1 < nodes.length && nodes[at + 1]?.parentId === milestoneId) at++;
      return at;
    };
    if (old.type === 'task' && old.parentId && nodes.some((n) => n.id === old.parentId)) {
      nodes.splice(blockEnd(old.parentId) + 1, 0, old);
      continue;
    }
    // An omitted milestone (its tasks follow it) goes after the milestone it followed before.
    const prevMs = (prev?.nodes ?? []).filter((n) => n.type === 'milestone').map((n) => n.id);
    const before = prevMs
      .slice(0, prevMs.indexOf(old.type === 'milestone' ? old.id : (old.parentId ?? '')))
      .reverse()
      .find((id) => nodes.some((n) => n.id === id));
    nodes.splice(before ? blockEnd(before) + 1 : 0, 0, old);
  }
  for (const p of parsed.park) {
    const n = nodes.find((x) => x.id === p.id);
    if (!n) throw new StateError(`cannot park unknown node ${p.id}`);
    if (n.status !== 'done') {
      n.status = 'parked';
      n.parkedReason = p.reason;
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const bad = n.dependsOn.find((d) => !ids.has(d) || d === n.id);
    if (bad) throw new StateError(`${n.id} depends on unknown node ${bad}`);
  }
  return { version: 1, goal, nodes };
}

const isDone = (plan: Plan, depId: string): boolean =>
  plan.nodes.find((n) => n.id === depId)?.status === 'done';

/** Leaf tasks that can run now, in plan order: todo/doing, deps done, milestone not parked or done. */
export function runnableTasks(plan: Plan): PlanNode[] {
  return plan.nodes.filter((n) => {
    if (n.type !== 'task' || n.status === 'done' || n.status === 'parked') return false;
    const parent = n.parentId ? plan.nodes.find((p) => p.id === n.parentId) : undefined;
    if (parent && (parent.status === 'parked' || parent.status === 'done')) return false;
    if (parent && !parent.dependsOn.every((d) => isDone(plan, d))) return false;
    return n.dependsOn.every((d) => isDone(plan, d));
  });
}

/** Milestones not yet done whose tasks are all settled (done) and that therefore need checks or expansion. */
export function milestonesAwaitingCheck(plan: Plan): PlanNode[] {
  return milestones(plan).filter((m) => {
    if (m.status === 'done' || m.status === 'parked') return false;
    const kids = childrenOf(plan, m.id);
    return kids.length > 0 && kids.every((k) => k.status === 'done');
  });
}

/** The first milestone that is not done/parked and has no tasks yet: rolling-wave expansion target. */
export function nextUnexpandedMilestone(plan: Plan): PlanNode | undefined {
  return milestones(plan).find(
    (m) => m.status !== 'done' && m.status !== 'parked' && childrenOf(plan, m.id).length === 0,
  );
}

export interface PlanCounts {
  milestones: number;
  milestonesDone: number;
  tasks: number;
  done: number;
  parked: number;
  todo: number;
}

export function planCounts(plan: Plan): PlanCounts {
  const tasks = plan.nodes.filter(isTask);
  const ms = milestones(plan);
  return {
    milestones: ms.length,
    milestonesDone: ms.filter((m) => m.status === 'done').length,
    tasks: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    parked: tasks.filter((t) => t.status === 'parked').length,
    todo: tasks.filter((t) => t.status === 'todo' || t.status === 'doing').length,
  };
}

const MARK: Record<NodeStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]', parked: '[p]' };

/**
 * The compact plan view for the cycle context (plan §14.1): goal, every milestone title with
 * status, the current milestone's tasks, and the full current task. Never the whole tree.
 */
export function compactPlanView(plan: Plan, currentTaskId: string | undefined): string {
  const current = currentTaskId ? plan.nodes.find((n) => n.id === currentTaskId) : undefined;
  const lines = ['Milestones:'];
  for (const m of milestones(plan)) {
    const kids = childrenOf(plan, m.id);
    const done = kids.filter((k) => k.status === 'done').length;
    lines.push(
      `${MARK[m.status]} ${m.id} ${m.title}${kids.length ? ` (${done}/${kids.length} tasks)` : ''}`,
    );
    if (current?.parentId === m.id && current.id) {
      for (const t of kids)
        lines.push(
          `    ${MARK[t.status]} ${t.id} ${t.title}${t.id === current.id ? '  <- current' : ''}`,
        );
    }
  }
  if (current) {
    lines.push('', `Current task ${current.id}: ${current.title}`);
    if (current.why) lines.push(`Why: ${current.why}`);
    if (current.acceptance.length)
      lines.push('Acceptance:', ...current.acceptance.map((a) => `- ${a}`));
    if (current.checks.length)
      lines.push('Checks the harness will run:', ...current.checks.map((c) => `- \`${c}\``));
    if (current.steps.length) lines.push('Suggested steps:', ...current.steps.map((s) => `- ${s}`));
    lines.push(`Size: ${current.size}. Kind: ${current.kind}. Attempt: ${current.attempts + 1}.`);
  }
  return lines.join('\n');
}
