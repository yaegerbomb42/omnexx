import { z } from 'zod';
import type { PlanNode } from '../core/plan.js';
import type { Run } from '../core/run.js';
import { estimateTokens } from '../core/tokens.js';

export const findingSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  file: z.string().max(300).default(''),
  problem: z.string().min(3).max(600),
  fix: z.string().max(600).default(''),
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewSchema = z.object({
  findings: z.array(findingSchema).max(20),
  summary: z.string().max(600).default(''),
});

const REVIEW_SYSTEM = `You are a strict senior engineer reviewing a change before it is committed by an autonomous coding agent. The tests already pass; your job is what tests miss.

Report only real problems, each with a severity:
- blocker: wrong behaviour; a requirement of the task or goal not actually met; a stub, placeholder or TODO where real code was needed; outputs hardcoded or special-cased to make tests pass; tests that don't exercise the behaviour they claim to; a security hole; data loss.
- major: an important edge case or error path left unhandled; an approach that will clearly break as the project grows.
- minor: anything smaller.
Never report style, naming or formatting. If the change is sound, return no findings. Reply only by calling the answer tool.`;

const AUDIT_SYSTEM = `You audit the result of a long autonomous coding run before it is allowed to finish. You get what the user asked for (the goal and its "done when" list) and the code as it is now.

List every gap between what was asked and what exists: a "done when" item not met, a feature missing or only stubbed, behaviour that is clearly shallow or untested, missing documentation the goal asked for. Each gap must be concrete and checkable, phrased as work to do. If everything asked for is genuinely done to a professional standard, return no findings. Reply only by calling the answer tool.`;

/** Keep the head and tail of a long diff: the start shows structure, the end the latest edits. */
export function clipDiff(diff: string, max: number): string {
  if (diff.length <= max) return diff;
  const half = Math.floor(max / 2);
  return `${diff.slice(0, half)}\n… [${diff.length - max} chars of the diff omitted] …\n${diff.slice(-half)}`;
}

export function blocking(findings: readonly Finding[], blockOn: 'blocker' | 'major'): Finding[] {
  return findings.filter(
    (f) => f.severity === 'blocker' || (blockOn === 'major' && f.severity === 'major'),
  );
}

export function renderFindings(findings: readonly Finding[]): string {
  return findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.problem}${f.fix ? ` Fix: ${f.fix}` : ''}`,
    )
    .join('\n');
}

async function ask(
  run: Run,
  system: string,
  prompt: string,
  role: string,
  chain: 'cheap' | 'worker' | 'planner',
): Promise<z.infer<typeof reviewSchema> | undefined> {
  const done = await run.cheapComplete(
    {
      system: [{ text: system }],
      tools: [
        {
          name: 'answer',
          description: 'Submit the findings',
          inputSchema: z.toJSONSchema(reviewSchema),
        },
      ],
      toolChoice: { type: 'tool', name: 'answer' },
      messages: [{ role: 'user', content: [{ type: 'text', text: run.redactor.text(prompt) }] }],
      maxTokens: 3_000,
      messageBreakpoints: [],
    },
    {
      estimatedInputTokens: estimateTokens(prompt) + 800,
      maxOutputTokens: 3_000,
      role,
      chain,
    },
  );
  const call = done?.res.content.find((b) => b.type === 'tool_use');
  const parsed = reviewSchema.safeParse(call?.type === 'tool_use' ? call.input : undefined);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Review one candidate change. Undefined when the review couldn't run (budget, outage, malformed
 * answer): the caller then accepts on the gates alone, so the reviewer never stalls a run.
 */
export async function reviewChange(
  run: Run,
  task: PlanNode,
  goal: string,
  diff: string,
): Promise<z.infer<typeof reviewSchema> | undefined> {
  const prompt = `# Goal\n${goal.slice(0, 3_000)}\n\n# Task ${task.id}: ${task.title}\n${task.why}\n${task.acceptance.length ? `Acceptance:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}` : ''}\n\n# The change (unified diff)\n${clipDiff(diff, run.config.review.max_diff_chars)}`;
  try {
    return await ask(run, REVIEW_SYSTEM, prompt, 'review', run.config.review.review_models);
  } catch (err) {
    run.events.emit('review.unavailable', { task: task.id, error: (err as Error).message });
    return undefined;
  }
}

/** Audit the finished work against what was asked. Undefined when the audit couldn't run. */
export async function auditResult(
  run: Run,
  goal: string,
  intent: string,
  codebase: string,
): Promise<z.infer<typeof reviewSchema> | undefined> {
  const prompt = `# What the user asked for\n${goal.slice(0, 4_000)}\n\n${intent.slice(0, 4_000)}\n\n# The code now\n${codebase}`;
  try {
    const r = await ask(run, AUDIT_SYSTEM, prompt, 'audit', run.config.review.audit_models);
    if (!r)
      run.events.emit('audit.unavailable', { error: 'no usable answer (budget or malformed)' });
    return r;
  } catch (err) {
    run.events.emit('audit.unavailable', { error: (err as Error).message });
    return undefined;
  }
}
