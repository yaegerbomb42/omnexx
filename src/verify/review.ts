import { WRITING_REVIEW_SYSTEM } from '../core/writing.js';
import { readScopeNotes } from '../agent/scopes.js';
import { z } from 'zod';
import type { PlanNode } from '../core/plan.js';
import type { Run } from '../core/run.js';
import { estimateTokens } from '../core/tokens.js';
import type { ContentBlock, Message, SystemBlock, ToolSpec } from '../providers/types.js';
import { extractJson } from './parsers/types.js';

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

const SEVERITY: Record<string, Finding['severity']> = {
  blocker: 'blocker',
  critical: 'blocker',
  major: 'major',
  high: 'major',
  important: 'major',
  minor: 'minor',
  medium: 'minor',
  low: 'minor',
  info: 'minor',
  nit: 'minor',
};
const PROBLEM_KEYS = [
  'problem',
  'finding',
  'issue',
  'description',
  'gap',
  'title',
  'text',
  'message',
];
const FINE = /^(ok|pass(ed)?|confirmed|met|done|resolved|none|fine)$/i;
const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * Models answer the findings tool in their own words: other field names, "critical" or "high"
 * for severity, a finding that only confirms something is fine, more than 20 items. Map those
 * onto the schema instead of discarding the whole review. A missing severity counts as minor,
 * so a garbled answer never blocks work it couldn't describe.
 */
export function coerceReview(input: unknown): z.infer<typeof reviewSchema> | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const raw = Array.isArray(o.findings)
    ? (o.findings as unknown[])
    : Array.isArray(o.gaps)
      ? (o.gaps as unknown[])
      : Array.isArray(o.issues)
        ? (o.issues as unknown[])
        : [];
  const findings: Finding[] = [];
  for (const item of raw) {
    const f =
      typeof item === 'string' ? { problem: item } : ((item ?? {}) as Record<string, unknown>);
    if (FINE.test(str(f.status, 40))) continue;
    const problem = PROBLEM_KEYS.map((k) => str(f[k], 600)).find((v) => v.length >= 3);
    if (!problem) continue;
    findings.push({
      severity: SEVERITY[str(f.severity ?? f.level ?? f.priority, 20).toLowerCase()] ?? 'minor',
      file: str(f.file ?? f.path, 300),
      problem,
      fix: str(f.fix ?? f.suggestion ?? f.recommendation, 600),
    });
  }
  const listed = ['findings', 'gaps', 'issues'].some((k) => Array.isArray(o[k]));
  if (!listed && typeof o.summary !== 'string') return undefined;
  return { findings: findings.slice(0, 20), summary: str(o.summary, 600) };
}

export const REVIEW_SYSTEM = `You are a strict senior engineer reviewing a change before it is committed by an autonomous coding agent. The tests already pass; your job is what tests miss.

Report only real problems, each with a severity:
- blocker: wrong behaviour; a requirement of the task or goal not actually met; a stub, placeholder or TODO where real code was needed; outputs hardcoded or special-cased to make tests pass; tests that don't exercise the behaviour they claim to; a security hole; data loss.
- major: an important edge case or error path left unhandled; an approach that will clearly break as the project grows.
- minor: anything smaller.
Where two requirements meet, walk one concrete call sequence through both: one operation built on another often inherits a guard or side effect meant only for outside callers (an internal step re-running a public check that its own earlier bookkeeping now fails). For concurrent or asynchronous code, check that results preserve the caller's ordering contract (not arrival order), concurrency bounds are enforced structurally (not just documented), and one failure does not leave resources or promises dangling. Tests often miss these; a sequence that throws or returns the wrong value is a blocker.
A blocker needs evidence: name the file and line, and the concrete input or call that now behaves wrongly. Speculation ("could", "might", "callers may rely on") is minor at most. Where the task or goal leaves a behaviour open (what an edge case should return), a reasonable choice is not a defect. Rejecting a working change throws the work away, so block only what you would bet is broken. You see only the diff: code it doesn't show (the module a new test exercises) is not a finding, and "could not verify" is never a blocker.
Never report style, naming or formatting. If the change is sound, return no findings. Reply only by calling the answer tool.`;

/** Room for a reasoning model's thinking before it answers: at 3k, glm-5.3 never got to the tool. */
const REVIEW_MAX_TOKENS = 8_000;
const AUDIT_MAX_TOKENS = 16_000;

export const AUDIT_SYSTEM = `You audit the result of a long autonomous coding run before it is allowed to finish. You get what the user asked for (the goal and its "done when" list) and the code as it is now.

List every gap between what was asked and what exists: a "done when" item or success criterion not met, a feature the goal asks for missing or only stubbed, documentation the goal asks for missing. Every change already passed the test gates and a per-change review. Judge only against what the goal and its "done when" list ask for: improvements, extra tests, hardening, cleanup of files the goal doesn't mention and stricter readings of the wording are not gaps (they belong to later improvement rounds). Each gap must be concrete and checkable, phrased as work to do, and severity major only when an explicit requirement is unmet. If what was asked for is done, return no findings. Reply only by calling the answer tool.`;

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

/** Added on the one retry after an empty or malformed answer (a model once sent `{}`). */
const ANSWER_SHAPE =
  '\n\nCall the answer tool with {"findings": [{"severity", "file", "problem", "fix"}, ...], "summary": "..."}. Use "findings": [] when nothing is wrong.';

const answerTool = {
  name: 'answer',
  description: 'Submit the findings',
  inputSchema: z.toJSONSchema(reviewSchema),
};

/**
 * The worker's cached prefix. System blocks are sent unchanged; `messages` is the conversation
 * so far, also unchanged. The rubric and the question go in one new user turn.
 */
export interface WorkerPrefix {
  system: readonly SystemBlock[];
  /** Sent unchanged: providers cache tools ahead of the system prompt, so swapping them misses. */
  tools: readonly ToolSpec[];
  messages: readonly Message[];
}

/** On the worker prefix the tools are the worker's, so the answer comes back as JSON text. */
const TEXT_ANSWER_SHAPE =
  '\n\nTools are disabled for this turn. Reply with only a JSON object: {"findings": [{"severity", "file", "problem", "fix"}, ...], "summary": "..."}. Use "findings": [] when nothing is wrong.';

/** Same estimate the agent loop uses before a model call (`system` + tools + messages). */
function requestTokens(
  system: readonly SystemBlock[],
  messages: readonly Message[],
  tools: readonly ToolSpec[] = [answerTool],
): number {
  return estimateTokens(JSON.stringify([system, tools, messages]));
}

/**
 * Whether appending the review turn stays inside the configured context budget
 * (`context.budget_tokens`). Unset means no cap, so the cached prefix is used.
 */
function prefixFits(run: Run, worker: WorkerPrefix, messages: readonly Message[]): boolean {
  const budget = run.config.context.budget_tokens;
  return budget === undefined || requestTokens(worker.system, messages, worker.tools) <= budget;
}

type AskSpec =
  | { path: 'standalone'; system: SystemBlock[]; messages: Message[] }
  | {
      path: 'prefix';
      system: readonly SystemBlock[];
      tools: readonly ToolSpec[];
      messages: Message[];
    };

/** Breakpoints on the first message and the last message that was already in the worker turn. */
function breakpoints(messages: readonly Message[], fresh: boolean): number[] {
  if (fresh || messages.length < 2) return [];
  const cachedLast = messages.length - 2;
  return cachedLast > 0 ? [0, cachedLast] : [0];
}

function standaloneSpec(run: Run, rubric: string, prompt: string): AskSpec {
  return {
    path: 'standalone',
    system: [{ text: rubric }],
    messages: [{ role: 'user', content: [{ type: 'text', text: run.redactor.text(prompt) }] }],
  };
}

/**
 * The worker's cache only pays off on the worker's model: another chain has its own cache, and
 * re-sending the whole conversation uncached costs far more than the short standalone prompt.
 */
function specFor(
  run: Run,
  rubric: string,
  prompt: string,
  chain: 'cheap' | 'worker' | 'planner',
  worker: WorkerPrefix | undefined,
): AskSpec {
  if (worker && chain === 'worker') {
    const text = `${rubric}\n\n${run.redactor.text(prompt)}${TEXT_ANSWER_SHAPE}`;
    const messages: Message[] = [
      ...worker.messages,
      { role: 'user', content: [{ type: 'text', text }] },
    ];
    if (prefixFits(run, worker, messages))
      return { path: 'prefix', system: worker.system, tools: worker.tools, messages };
  }
  return standaloneSpec(run, rubric, prompt);
}

/** The one retry spells the answer shape onto the user turn already chosen. */
function withShape(spec: AskSpec): AskSpec {
  const messages = spec.messages.map((m, i) =>
    i === spec.messages.length - 1
      ? {
          ...m,
          content: m.content.map((b, j) =>
            j === m.content.length - 1 && b.type === 'text'
              ? { ...b, text: b.text + ANSWER_SHAPE }
              : b,
          ),
        }
      : m,
  );
  return { ...spec, messages };
}

async function ask(
  run: Run,
  rubric: string,
  prompt: string,
  role: 'review' | 'audit',
  chain: 'cheap' | 'worker' | 'planner',
  maxTokens: number,
  worker: WorkerPrefix | undefined,
  extra: Record<string, unknown>,
  why?: (reason: string) => void,
): Promise<z.infer<typeof reviewSchema> | undefined> {
  const event = role === 'audit' ? 'audit.cache_path' : 'review.cache_path';
  let spec = specFor(run, rubric, prompt, chain, worker);
  run.events.emit(event, { path: spec.path, ...extra });
  if (spec.path === 'prefix') {
    const cached = await askOnce(run, spec, role, chain, maxTokens, why);
    if (cached) return cached;
    spec = standaloneSpec(run, rubric, prompt);
    run.events.emit(event, { path: spec.path, fallback: true, ...extra });
  }
  const last = { reason: '' };
  const first = await askOnce(run, spec, role, chain, maxTokens, (w) => {
    last.reason = w;
    why?.(w);
  });
  if (first || !last.reason.startsWith('unusable findings')) return first;
  return askOnce(run, withShape(spec), role, chain, maxTokens, why);
}

async function askOnce(
  run: Run,
  spec: AskSpec,
  role: string,
  chain: 'cheap' | 'worker' | 'planner',
  maxTokens: number,
  why?: (reason: string) => void,
): Promise<z.infer<typeof reviewSchema> | undefined> {
  const tools = spec.path === 'prefix' ? [...spec.tools] : [answerTool];
  const done = await run.cheapComplete(
    {
      system: spec.system as SystemBlock[],
      tools,
      toolChoice: spec.path === 'prefix' ? { type: 'none' } : { type: 'tool', name: 'answer' },
      messages: spec.messages,
      maxTokens,
      messageBreakpoints: breakpoints(spec.messages, spec.path === 'standalone'),
    },
    {
      estimatedInputTokens: requestTokens(spec.system, spec.messages, tools),
      maxOutputTokens: maxTokens,
      role,
      chain,
    },
  );
  if (!done) {
    why?.('the budget preflight refused the call');
    return undefined;
  }
  const answer = answerIn(done.res.content, spec.path);
  if (answer === undefined) {
    why?.(`${done.model.provider}:${done.model.id} gave no answer (stop: ${done.res.stopReason})`);
    return undefined;
  }
  const r = coerceReview(answer);
  if (!r) why?.(`unusable findings from ${done.model.id}: ${JSON.stringify(answer).slice(0, 200)}`);
  return r;
}

/** The answer tool's input, or on the worker prefix the JSON object in the reply text. */
function answerIn(content: readonly ContentBlock[], path: AskSpec['path']): unknown {
  if (path === 'standalone') {
    const call = content.find((b) => b.type === 'tool_use');
    return call?.type === 'tool_use' ? call.input : undefined;
  }
  const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return extractJson(text, '{');
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
  worker?: WorkerPrefix,
): Promise<z.infer<typeof reviewSchema> | undefined> {
  // A writing review checks the piece against the bible the author keeps in its general notes.
  const bible = run.state.writing
    ? await readScopeNotes({ store: run.store, repoRoot: run.state.repoRoot }, 'general').catch(
        () => '',
      )
    : '';
  const acceptance = task.acceptance.map((a) => '- ' + a).join('\n');
  const prompt = [
    `# Goal\n${goal.slice(0, 3_000)}`,
    ...(bible ? [`# The author's bible (names, facts, style)\n${bible.slice(0, 6_000)}`] : []),
    `# Task ${task.id}: ${task.title}\n${task.why}\n${acceptance ? 'Acceptance:\n' + acceptance : ''}`,
    `# The change (unified diff)\n${clipDiff(diff, run.config.review.max_diff_chars)}`,
  ].join('\n\n');
  try {
    return await ask(
      run,
      run.state.writing ? WRITING_REVIEW_SYSTEM : REVIEW_SYSTEM,
      prompt,
      'review',
      run.config.review.review_models,
      REVIEW_MAX_TOKENS,
      worker,
      { task: task.id },
    );
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
  worker?: WorkerPrefix,
): Promise<z.infer<typeof reviewSchema> | undefined> {
  const prompt = `# What the user asked for\n${goal.slice(0, 4_000)}\n\n${intent.slice(0, 4_000)}\n\n# The work now\n${codebase}`;
  try {
    // Audits go to the planner chain, often reasoning models: their thinking counts against the
    // output limit, and 3k tokens ran out before the answer on every bench run.
    let reason = 'no usable answer';
    const r = await ask(
      run,
      AUDIT_SYSTEM,
      prompt,
      'audit',
      run.config.review.audit_models,
      AUDIT_MAX_TOKENS,
      worker,
      {},
      (w) => (reason = w),
    );
    if (!r) run.events.emit('audit.unavailable', { error: reason });
    return r;
  } catch (err) {
    run.events.emit('audit.unavailable', { error: (err as Error).message });
    return undefined;
  }
}
