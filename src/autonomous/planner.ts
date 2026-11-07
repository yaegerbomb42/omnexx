/**
 * LlmArchitectPlanner — the LLM-backed `ArchitectPlanner` for the autonomous daemon.
 *
 * One bounded LLM turn (up to 3 attempts, walking the planner model chain) that
 * turns a queued task into a `TaskExecutionPlan` as JSON. The daemon
 * (`daemon.ts`) calls `plan(task)` from PLAN and fails the task closed when
 * this throws — so this module never fabricates a plan: malformed model output
 * is retried, then surfaced as an error.
 *
 * Design constraints, from the daemon design doc:
 * - Prompt stays small (<3k tokens of starting context): task metadata, a
 *   capped target-file list, and a truncated, secret-redacted finding payload.
 * - `filesToTouch` is always a subset of the task's target files when those
 *   are known; the model never invents files outside the repo.
 * - `verificationCommand` is a single real repo command (test / typecheck /
 *   lint for the touched area); no chaining, pipes, or redirects.
 * - Read-only: no filesystem access at all — context comes from the task.
 */

import type { OmnexxConfig } from '../config/schema.js';
import { costUsd, resolveChain, type ResolvedModel } from '../providers/pricing.js';
import {
  type CompletionRequest,
  type CompletionResponse,
  type Provider,
} from '../providers/types.js';
import type { DaemonUsageRecorder } from './budget-gate.js';
import { usageTokenTotals } from './budget-gate.js';
import { boundPlan, type ArchitectPlanner, type TaskExecutionPlan } from './daemon.js';
import type { QueuedTask } from './state-store.js';
import { isTestFilePath } from './ast-analysis.js';

export type PlannerLogger = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Default output cap: a plan is a small JSON object, not prose — but reasoning
 * models spend most of their output budget thinking (Nemotron 3.x used ~870
 * reasoning tokens before emitting ~50 tokens of JSON in a live test), so the
 * cap needs headroom above the JSON itself or every attempt comes back empty.
 */
export const DEFAULT_PLANNER_MAX_TOKENS = 4096;
/** Total `Provider.complete` calls before giving up and throwing. */
export const MAX_PLANNER_ATTEMPTS = 3;
/** Finding-payload characters sent to the model (keeps the prompt small). */
export const MAX_PAYLOAD_CHARS = 1500;
/** Target files listed in the prompt (the plan itself is capped at 6). */
export const MAX_PROMPT_TARGET_FILES = 12;

const SYSTEM_PROMPT = [
  'You are the Architect for an autonomous coding daemon. Given one queued task,',
  'produce a bounded execution plan as JSON. Reply with ONLY the JSON object,',
  'no prose, no markdown fences around anything else.',
  '',
  'JSON shape:',
  '{',
  '  "filesToTouch": ["<relative repo path>", ...],  // at most 6, ONLY files listed in the task',
  '  "verificationCommand": "<single command>",     // e.g. "npx vitest run test/foo.test.ts"',
  '  "subSteps": ["<concrete step>", ...],           // at most 5',
  '  "summary": "<one line>"',
  '}',
  '',
  'Rules:',
  "- filesToTouch must be a subset of the task's target files. Never invent a file.",
  '- verificationCommand is ONE command: no &&, pipes, redirects, or shell substitution.',
  "  Prefer the repo's own check for the touched area (npx vitest run <path>,",
  '  npx tsc --noEmit); fall back to "npm run typecheck" when unsure.',
  '- subSteps are concrete, ordered, and implementable from the finding alone.',
  '- summary is a single line describing the change.',
  // Test-file authorization (live case 2026-11-06: the executor changed
  // `toBe(5)` → `toBe(6)` and never touched the source). Listing a test file
  // in filesToTouch does NOT authorize editing it — the executor refuses
  // test-file writes unless a sub-step explicitly says to ADD tests there,
  // and it never authorizes changing an existing expectation. The flag lives
  // in a sub-step (not a plan field) because `boundPlan` in daemon.ts strips
  // unknown plan fields before the plan reaches the executor.
  '- If the task needs new tests, name the test file in filesToTouch AND write a sub-step that says so explicitly, e.g. "Add new test(s) in <test file>": without that sub-step the executor cannot touch the test file at all. Never plan a change to an existing test expectation — a failing test is fixed by fixing the source, not the expectation.',
].join('\n');

/** Shell metacharacters / words that have no place in a verification command. */
const UNSAFE_COMMAND = /[\n\r;&|`$<>]/;
const UNSAFE_COMMAND_WORDS = /\brm\s+-rf\b|\bsudo\b|\bcurl\b|\bwget\b|\bgit\s+push\b/;

export interface LlmArchitectPlannerOptions {
  provider: Provider;
  /** Failover chain, tried in order (one model per attempt, cycling). */
  models: readonly ResolvedModel[];
  maxTokens?: number;
  logger?: PlannerLogger;
  /**
   * Called after each successful model call with the priced usage, so the
   * daemon's budget ledger sees the spend (the gate reads the ledger; an
   * unreported call is invisible to the caps).
   */
  onUsage?: DaemonUsageRecorder;
}

export interface CreateArchitectPlannerOptions {
  provider: Provider;
  config: OmnexxConfig;
  logger?: PlannerLogger;
  onUsage?: DaemonUsageRecorder;
}

/**
 * Resolve the planner model chain from `config.models.planner` the same way
 * the run path does (`resolveChain` in `src/core/run.ts`): the config order
 * is the failover order. The provider is expected to be a `ProviderRouter`
 * (or any `Provider`); each `ResolvedModel` carries its provider as the
 * request `route` and its concrete id as the request `model`.
 */
export function createArchitectPlanner(opts: CreateArchitectPlannerOptions): LlmArchitectPlanner {
  return new LlmArchitectPlanner({
    provider: opts.provider,
    models: resolveChain(opts.config.models.planner, opts.config),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
  });
}

export class LlmArchitectPlanner implements ArchitectPlanner {
  private readonly provider: Provider;
  private readonly models: readonly ResolvedModel[];
  private readonly maxTokens: number;
  private readonly logger: PlannerLogger;
  private readonly onUsage: DaemonUsageRecorder | undefined;

  constructor(opts: LlmArchitectPlannerOptions) {
    if (opts.models.length === 0) {
      throw new Error('architect planner: no planner models configured');
    }
    this.provider = opts.provider;
    this.models = opts.models;
    this.maxTokens =
      opts.maxTokens !== undefined && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
        ? Math.floor(opts.maxTokens)
        : DEFAULT_PLANNER_MAX_TOKENS;
    this.logger = opts.logger ?? console;
    this.onUsage = opts.onUsage;
  }

  async plan(task: QueuedTask): Promise<TaskExecutionPlan> {
    let lastError = 'no attempts made';
    for (let attempt = 0; attempt < MAX_PLANNER_ATTEMPTS; attempt++) {
      const model = this.models[attempt % this.models.length] as ResolvedModel;
      try {
        const response = await this.provider.complete(
          this.buildRequest(task, model, attempt, lastError),
        );
        // Record the call's priced usage before parsing: the tokens were
        // spent even if the reply turns out to be unusable JSON.
        const totals = usageTokenTotals(response.usage);
        this.onUsage?.({
          taskId: task.taskId,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          usd: costUsd(response.usage, model.price),
        });
        const parsed = extractPlanJson(responseText(response));
        return boundPlan(validatePlan(parsed, task));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[planner] attempt ${attempt + 1}/${MAX_PLANNER_ATTEMPTS} failed for ` +
            `${task.taskId} (${model.provider}:${model.id}): ${lastError}`,
        );
      }
    }
    throw new Error(
      `architect planner: no valid plan for task ${task.taskId} after ` +
        `${MAX_PLANNER_ATTEMPTS} attempts (last: ${lastError})`,
    );
  }

  private buildRequest(
    task: QueuedTask,
    model: ResolvedModel,
    attempt: number,
    lastError: string,
  ): CompletionRequest {
    const userText =
      attempt === 0
        ? buildTaskPrompt(task)
        : `${buildTaskPrompt(task)}\n\nYour previous reply was not usable: ${lastError}\n` +
          'Reply with ONLY the JSON plan object this time.';
    return {
      model: model.id,
      route: model.provider,
      system: [{ text: SYSTEM_PROMPT }],
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      maxTokens: this.maxTokens,
      messageBreakpoints: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Task context for the model: metadata + capped files + redacted payload. */
export function buildTaskPrompt(task: QueuedTask): string {
  const lines = [
    `Task: ${task.taskId}`,
    `Source collector: ${task.sourceCollector}`,
    `Fingerprint: ${task.fingerprint}`,
    `Priority score: ${task.priorityScore}`,
  ];
  if (task.targetFiles.length > 0) {
    const listed = task.targetFiles.slice(0, MAX_PROMPT_TARGET_FILES);
    lines.push(`Target files (${task.targetFiles.length}):`);
    for (const file of listed) lines.push(`- ${file}`);
    if (task.targetFiles.length > MAX_PROMPT_TARGET_FILES) {
      lines.push(`- ... and ${task.targetFiles.length - MAX_PROMPT_TARGET_FILES} more`);
    }
  } else {
    lines.push('Target files: (none recorded — use only files named in the finding)');
  }
  const payload = payloadText(task.findingPayload);
  if (payload) lines.push(`Finding:\n${payload}`);
  return lines.join('\n');
}

/** Finding payload as text: secret-redacted, truncated to keep the prompt small. */
function payloadText(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(redactSecrets(payload));
  } catch {
    text = '[unserializable finding payload]';
  }
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}\n…(truncated)`
    : text;
}

const SECRET_KEY = /api[_-]?key|token|secret|password|passwd|auth|credential|private[_-]?key/i;

/** Deep-copy with secret-looking values replaced; secrets never reach a prompt. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.exec(key) !== null ? '[redacted]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Response parsing + validation
// ---------------------------------------------------------------------------

function responseText(response: CompletionResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Pull the plan JSON out of a reply: a fenced ```json block first, else the
 * outermost `{...}` span. Throws on anything unparseable — never guess.
 */
const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/;

export function extractPlanJson(text: string): unknown {
  if (!text) throw new Error('empty model response');
  const fenced = FENCED_JSON.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('no JSON object in model response');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error('model response is not valid JSON');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const cleanStrings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** Normalize a repo-relative path; null when it escapes the repo or is absolute. */
function normalizeRepoPath(file: string): string | null {
  const cleaned = file.trim().replace(/^\.\//, '');
  if (!cleaned || cleaned.startsWith('/') || cleaned.split('/').includes('..')) return null;
  return cleaned;
}

/**
 * Validate a parsed plan. Throws on any malformed shape; drops files outside
 * the task's targets (when known) and fails when nothing known is left.
 * Bounds (≤6 files, ≤5 steps) are applied by `boundPlan` on the way out.
 */
export function validatePlan(parsed: unknown, task: QueuedTask): TaskExecutionPlan {
  if (!isRecord(parsed)) throw new Error('plan is not a JSON object');
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw new Error('plan has no summary');

  const command =
    typeof parsed.verificationCommand === 'string' ? parsed.verificationCommand.trim() : '';
  if (!command) throw new Error('plan has no verificationCommand');
  if (UNSAFE_COMMAND.exec(command) !== null || UNSAFE_COMMAND_WORDS.exec(command) !== null) {
    throw new Error(`verificationCommand is unsafe: ${command.slice(0, 80)}`);
  }

  const subSteps = [...new Set(cleanStrings(parsed.subSteps))];
  if (subSteps.length === 0) throw new Error('plan has no subSteps');

  const known =
    task.targetFiles.length > 0
      ? new Set(
          task.targetFiles.map((f) => normalizeRepoPath(f)).filter((f): f is string => f !== null),
        )
      : null;
  const seen = new Set<string>();
  const filesToTouch: string[] = [];
  for (const raw of cleanStrings(parsed.filesToTouch)) {
    const file = normalizeRepoPath(raw);
    if (file === null || seen.has(file)) continue;
    seen.add(file);
    // Allow known target files as well as authorized test files needed to verify the task
    if (known !== null && !known.has(file) && !isTestFilePath(file)) continue;
    filesToTouch.push(file);
  }
  const touchesKnown =
    known === null ||
    filesToTouch.some((f) => known.has(f)) ||
    filesToTouch.some(isTestFilePath);
  if (filesToTouch.length === 0 || !touchesKnown) {
    throw new Error(
      known !== null ? 'plan touches no known target file' : 'plan has no filesToTouch',
    );
  }

  return { filesToTouch, verificationCommand: command, subSteps, summary };
}
