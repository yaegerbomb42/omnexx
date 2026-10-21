import { compactPlanView, type Plan, type PlanNode } from '../core/plan.js';
import { contentsBlock, type SectionId, type SectionModes } from './sections.js';
import type { CompletionRequest, Message, SystemBlock, ToolSpec } from '../providers/types.js';

/** Everything a cycle starts from. Built from disk each cycle; nothing carries over. */
export interface CycleInputs {
  systemPrompt: string;
  codemap: string;
  goal: string;
  /** intent.md from the initial planner; empty until written. */
  intent?: string;
  notes: string;
  plan: Plan;
  task: PlanNode;
  progressTail: string;
  /** Harness-generated evidence about this task: failures, rejected patch summaries, judge notes. */
  evidence: string[];
  /**
   * Salience-ranked progress and evidence from the memory harness. When set it replaces the
   * plain progress and evidence sections; it lives in the per-cycle message, after the
   * system breakpoint, so it never invalidates the cached prefix.
   */
  memory?: string;
  /** The task's running context: the agent's own living memory from earlier cycles. */
  runningContext?: string;
  /** The task's role card (who the agent is for it, what done means). */
  role?: string;
  /** What the user's agent settings mean (effort, time); a volatile block after the goal. */
  brief?: string;
  /** The repo's verified facts (how it builds and tests); a volatile block after the settings. */
  facts?: string;
  /** How each section reaches the model; all pinned when unset (the old behaviour). */
  sections?: SectionModes;
  tools: ToolSpec[];
}

const ALL_PINNED: SectionModes = {
  role: 'pinned',
  codemap: 'pinned',
  intent: 'pinned',
  lessons: 'pinned',
  progress: 'pinned',
};

/**
 * Stable prefix, in fixed order (plan §4.1): tools → system prompt → codemap → goal → notes,
 * breakpoint. Then the cycle-state message (plan view, progress, task evidence), breakpoint.
 * No timestamps or random ids anywhere in it.
 */
export function buildCycleContext(i: CycleInputs): {
  system: SystemBlock[];
  first: Message;
  tools: ToolSpec[];
  /** One name per system block, for the context breakdown. */
  labels: string[];
} {
  const modes = i.sections ?? ALL_PINNED;
  const optional: { id: SectionId; text: string }[] = [];
  /** Pinned: send it. Optional: list it in the table of contents. Hidden: neither. */
  const keep = (id: SectionId, text: string | undefined): boolean => {
    if (!text?.trim()) return false;
    if (modes[id] === 'optional') optional.push({ id, text });
    return modes[id] === 'pinned';
  };

  const blocks: { label: string; text: string }[] = [{ label: 'system', text: i.systemPrompt }];
  if (keep('codemap', i.codemap)) blocks.push({ label: 'codemap', text: i.codemap });
  const intent = keep('intent', i.intent) ? `\n\n${i.intent ?? ''}` : '';
  blocks.push({ label: 'goal', text: `# Goal\n\n${i.goal.trim()}${intent}` });
  if (i.brief?.trim()) blocks.push({ label: 'settings', text: i.brief.trim() });
  if (i.facts?.trim()) blocks.push({ label: 'facts', text: i.facts.trim() });
  if (keep('lessons', i.notes))
    blocks.push({ label: 'notes', text: `# Lessons (notes.md)\n\n${i.notes.trim()}` });
  const system: SystemBlock[] = blocks.map((b, n) => ({
    text: b.text,
    ...(n > 0 ? { volatile: true } : {}),
    ...(n === blocks.length - 1 ? { cacheBreakpoint: true } : {}),
  }));

  const parts = [`# Plan\n\n${compactPlanView(i.plan, i.task.id)}`];
  const progress = i.memory ?? (i.progressTail ? `# Recent progress\n\n${i.progressTail}` : '');
  if (keep('progress', progress)) parts.push(progress);
  if (i.task.approachesTried.length || i.task.lastRejection) {
    const lines = [
      ...i.task.approachesTried.map((a) => `- [failed approach] ${a}`),
      ...(i.task.lastRejection ? [`- [last rejection] ${i.task.lastRejection}`] : []),
    ];
    parts.push(
      `# Negative Knowledge & Dead Ends for ${i.task.id} (do not repeat these)\n\n${lines.join('\n')}`,
    );
  }
  if (!i.memory && i.evidence.length)
    parts.push(`# Evidence from earlier attempts\n\n${i.evidence.join('\n\n')}`);
  if (i.runningContext)
    parts.push(
      `# Your running context for ${i.task.id} (where the work stands; keep adding with running_context)\n\n${i.runningContext}`,
    );
  if (keep('role', i.role)) parts.push((i.role ?? '').trim());
  const contents = contentsBlock(optional);
  if (contents) parts.push(contents);
  parts.push(
    `# Your task now\n\nWork on ${i.task.id}: ${i.task.title}. Stop calling tools and summarize when it is done or you are blocked.`,
  );
  return {
    system,
    first: { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] },
    tools: i.tools,
    labels: blocks.map((b) => b.label),
  };
}

/** Request for the next turn: first message and the latest message carry breakpoints. */
export function turnRequest(
  ctx: { system: SystemBlock[]; tools: ToolSpec[] },
  messages: Message[],
  model: string,
  maxTokens: number,
  cacheKey?: string,
): Omit<CompletionRequest, 'signal'> {
  const last = messages.length - 1;
  return {
    model,
    system: ctx.system,
    tools: ctx.tools,
    messages,
    maxTokens,
    messageBreakpoints: last > 0 ? [0, last] : [0],
    ...(cacheKey ? { promptCacheKey: cacheKey } : {}),
  };
}
