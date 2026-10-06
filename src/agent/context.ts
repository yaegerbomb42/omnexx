import { compactPlanView, type Plan, type PlanNode } from '../core/plan.js';
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
  tools: ToolSpec[];
}

/**
 * Stable prefix, in fixed order (plan §4.1): tools → system prompt → codemap → goal → notes,
 * breakpoint. Then the cycle-state message (plan view, progress, task evidence), breakpoint.
 * No timestamps or random ids anywhere in it.
 */
export function buildCycleContext(i: CycleInputs): {
  system: SystemBlock[];
  first: Message;
  tools: ToolSpec[];
} {
  const system: SystemBlock[] = [
    { text: i.systemPrompt },
    { text: i.codemap },
    { text: i.intent ? `# Goal\n\n${i.goal.trim()}\n\n${i.intent}` : `# Goal\n\n${i.goal.trim()}` },
    { text: `# Lessons (notes.md)\n\n${i.notes.trim()}`, cacheBreakpoint: true },
  ];
  const parts = [`# Plan\n\n${compactPlanView(i.plan, i.task.id)}`];
  if (i.memory) parts.push(i.memory);
  else if (i.progressTail) parts.push(`# Recent progress\n\n${i.progressTail}`);
  if (i.task.approachesTried.length) {
    parts.push(
      `# Approaches already tried for ${i.task.id} (do not repeat these)\n\n${i.task.approachesTried.map((a) => `- ${a}`).join('\n')}`,
    );
  }
  if (!i.memory && i.evidence.length)
    parts.push(`# Evidence from earlier attempts\n\n${i.evidence.join('\n\n')}`);
  parts.push(
    `# Your task now\n\nWork on ${i.task.id}: ${i.task.title}. Stop calling tools and summarize when it is done or you are blocked.`,
  );
  return {
    system,
    first: { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] },
    tools: i.tools,
  };
}

/** Request for the next turn: first message and the latest message carry breakpoints. */
export function turnRequest(
  ctx: { system: SystemBlock[]; tools: ToolSpec[] },
  messages: Message[],
  model: string,
  maxTokens: number,
): Omit<CompletionRequest, 'signal'> {
  const last = messages.length - 1;
  return {
    model,
    system: ctx.system,
    tools: ctx.tools,
    messages,
    maxTokens,
    messageBreakpoints: last > 0 ? [0, last] : [0],
  };
}
