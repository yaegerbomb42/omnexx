/**
 * AgentTaskExecutor — the daemon's IMPLEMENT driver.
 *
 * One `executeTurn` call is ONE model turn inside the task's isolated
 * worktree: one provider call (with failover across the worker chain), the
 * model's tool calls executed through the real tool registry, then the
 * per-turn result the daemon's IMPLEMENT loop and circuit breaker consume.
 *
 * This is deliberately NOT a second agent loop. The multi-turn loop lives in
 * the daemon (`AutonomousDaemon.implementTask` drives up to 25 turns); this
 * class owns a single turn and the per-task conversation that spans turns.
 * Everything it reuses, and what it had to write itself, is listed at the
 * bottom of this file.
 *
 * Safety, in layers (outermost first):
 * 1. The tool list is the core registry only (`workerTools` with no extra
 *    sources), minus the tools a daemon task must never have: `task`
 *    (unbounded subagents), `define_contract` (the harness owns the plan
 *    contract), and the cross-run note tools (`context`, `remember`,
 *    `recall`, `running_context`).
 * 2. `ContractGate` is pre-registered with the plan's `filesToTouch`, so
 *    the edit tools (`str_replace`, `multi_edit`, `replace_lines`,
 *    `write_file`) refuse out-of-plan edits themselves.
 * 3. A pre-execution guard in this file re-checks every call before it
 *    runs: the daemon denylist (`assertPathAllowed`), plan membership for
 *    mutating file tools, and the daemon shell firewall
 *    (`checkDaemonCommand`, plus a best-effort redirect/`tee` target check)
 *    for `bash`. A refused call returns an error *result* to the model, so
 *    the turn continues and the circuit breaker sees the error — it never
 *    throws out of `executeTurn`. The guard also owns the test-file rule:
 *    an existing test file is read-only unless the plan explicitly
 *    authorizes adding tests there, and even then only purely additive
 *    edits are allowed — never a changed or removed expectation.
 * 4. `PathJail` (the tools' own jail) and the bash command policy confine
 *    every path/command to the worktree; child env is `daemonEnv` (secrets
 *    stripped).
 */
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { decodeJsonStrings, lenientInput } from '../agent/loop.js';
import { turnRequest } from '../agent/context.js';
import { getWorkerPrompt } from '../agent/prompts.js';
import { parseDuration } from '../config/duration.js';
import { callOrder, strategyFor } from '../config/routing.js';
import type { OmnexxConfig } from '../config/schema.js';
import { workModeOf } from '../config/work-mode.js';
import { ContractGate } from '../core/contract.js';
import { realClock, type Clock } from '../core/clock.js';
import { EventLog } from '../core/events.js';
import { runShell } from '../core/exec.js';
import { resolvePaths } from '../core/paths.js';
import { RunStore } from '../core/run-store.js';
import { estimateTokens } from '../core/tokens.js';
import { ProviderError } from '../errors.js';
import { statusPorcelain, workingTreeDiff } from '../git/repo.js';
import { preflight } from '../guard/budget.js';
import { costUsd, resolveChain, type ResolvedModel } from '../providers/pricing.js';
import type { DaemonUsageRecorder } from './budget-gate.js';
import { usageTokenTotals } from './budget-gate.js';
import { shouldFailover } from '../providers/router.js';
import {
  type CompletionResponse,
  type ContentBlock,
  type Message,
  type Provider,
  type SystemBlock,
  type ToolSpec,
} from '../providers/types.js';
import { daemonEnv, assertDaemonCommand, assertPathAllowed } from './tool-guard.js';
import { isTestFilePath } from './ast-analysis.js';
import type {
  DaemonLogger,
  TaskExecutionPlan,
  TaskExecutor,
  ToolCallRecord,
  TurnResult,
} from './daemon.js';
import type { QueuedTask } from './state-store.js';
import { isInside, PathJail } from '../security/paths.js';
import { Redactor } from '../security/redact.js';
import { buildToolListSync, toolSpec, workerTools } from '../tools/registry.js';
import type { Tool, ToolContext, ToolOutput } from '../tools/types.js';

/**
 * The daemon-safe tool set: the core file/shell/note tools. Everything else
 * in the registry is excluded — `task` (subagents are unbounded),
 * `define_contract` (the harness owns the contract), `context` / `remember` /
 * `recall` / `running_context` (cross-run note state the daemon must not
 * pollute), `query_artifact` / `repl_projection` (run artifacts / REPL).
 */
export const DAEMON_TOOLS: readonly string[] = [
  'read',
  'outline',
  'read_symbol',
  'search',
  'str_replace',
  'multi_edit',
  'replace_lines',
  'write_file',
  'bash',
  'read_log',
  'todo',
];

/**
 * Tool names models invent for tools that exist under another name (copied
 * from `src/agent/loop.ts`: `TOOL_ALIASES` is module-private there, so the
 * single-turn driver keeps its own copy to resolve calls the same way).
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  print_tree: 'outline',
  tree: 'outline',
  ls: 'outline',
  list_files: 'outline',
  list_dir: 'outline',
  list_directory: 'outline',
  file_tree: 'outline',
  find_files: 'outline',
  glob: 'outline',
  list: 'outline',
  grep: 'search',
  list_capabilities: 'manage_capabilities',
  ripgrep: 'search',
  search_files: 'search',
  search_code: 'search',
  code_search: 'search',
  cat: 'read',
  read_file: 'read',
  open_file: 'read',
  view_file: 'read',
  view: 'read',
  create_file: 'write_file',
  write: 'write_file',
  edit: 'str_replace',
  edit_file: 'str_replace',
  replace: 'str_replace',
  shell: 'bash',
  run: 'bash',
  run_command: 'bash',
  execute: 'bash',
  exec: 'bash',
};

/** History cap: the turn-1 anchor plus the most recent turns (whole turns only). */
const MAX_HISTORY_MESSAGES = 25;
/** One tool result kept in the conversation is cut here (the model never needs more). */
const MAX_TOOL_RESULT_CHARS = 12_000;
/** `inputSummary` / `errorContent` caps, matching the agent loop's 300/500. */
const MAX_INPUT_SUMMARY_CHARS = 300;
const MAX_ERROR_CHARS = 500;

export interface AgentTaskExecutorOptions {
  repoRoot: string;
  provider: Provider;
  models: readonly ResolvedModel[];
  config: OmnexxConfig;
  clock?: Clock;
  logger?: DaemonLogger;
  /**
   * Called after each successful model call with the priced usage, so the
   * daemon's budget ledger sees the spend (the gate reads the ledger; an
   * unreported call is invisible to the caps).
   */
  onUsage?: DaemonUsageRecorder;
}

/** Everything one task's turns share: conversation, tools, and tool context. */
interface TaskAgentContext {
  taskId: string;
  plan: TaskExecutionPlan;
  worktree: string;
  initialTestFiles: ReadonlySet<string>;
  messages: Message[];
  system: SystemBlock[];
  tools: readonly Tool[];
  specs: ToolSpec[];
  byName: Map<string, Tool>;
  toolCtx: ToolContext;
  store: RunStore;
  edited: Set<string>;
  /** Spend (USD) on this task so far, for the per-call budget preflight. */
  spentUsd: number;
}

const summarizeInput = (input: unknown): string => {
  if (input === undefined) return '';
  const s = JSON.stringify(input);
  return s.length > MAX_INPUT_SUMMARY_CHARS ? `${s.slice(0, MAX_INPUT_SUMMARY_CHARS)}…` : s;
};

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Throw the abort reason when the daemon/breaker stopped this turn. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('executeTurn aborted');
  }
}

/** Repo-relative posix path for a user-supplied path, or undefined when unusable. */
function relPosix(worktree: string, p: string): string | undefined {
  if (typeof p !== 'string' || !p.trim()) return undefined;
  const abs = resolve(worktree, p);
  if (!isInside(worktree, abs)) return undefined;
  return relative(worktree, abs).split(sep).join('/');
}

/** File paths a tool input names (`path`, `paths[]`, `files[].path`). */
function pathsFromInput(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const out: string[] = [];
  const rec = input as Record<string, unknown>;
  if (typeof rec.path === 'string') out.push(rec.path);
  if (Array.isArray(rec.paths)) for (const p of rec.paths) if (typeof p === 'string') out.push(p);
  if (Array.isArray(rec.files))
    for (const f of rec.files)
      if (
        typeof f === 'object' &&
        f !== null &&
        typeof (f as Record<string, unknown>).path === 'string'
      )
        out.push((f as Record<string, unknown>).path as string);
  return out;
}

/** Split a shell command into tokens, respecting single/double quotes. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: "'" | '"' | undefined;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      if (ch === ';' || ch === '&' || ch === '|') tokens.push(ch);
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Best-effort file-write targets of a bash command: `>` / `>>` redirection
 * targets and `tee` operands. The command policy already denies writes
 * outside the worktree; this adds the plan-membership check the policy
 * cannot know. Anything it cannot parse is left to the policy + the jail.
 */
function bashWriteTargets(command: string): string[] {
  const tokens = shellTokens(command);
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '>' || t === '>>') && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('&') && !/^\d+$/.test(next)) targets.push(next);
    } else if (t === 'tee') {
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j];
        if (!arg || arg === ';' || arg === '&' || arg === '|') break;
        if (arg.startsWith('-')) continue;
        targets.push(arg);
      }
    }
  }
  return targets;
}

/**
 * `git status --porcelain` of a worktree, as path → status code; empty when
 * not a repo. Comparing codes (not just path sets) catches a file that was
 * already dirty before the turn and changed again during it.
 */
async function porcelainStatus(worktree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = await statusPorcelain(worktree);
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3);
    const arrow = pathPart.indexOf(' -> ');
    const resolvedPath = arrow >= 0 ? pathPart.slice(arrow + 4) : pathPart;
    const code = line.slice(0, 2);
    if (code === '??') {
      try {
        const s = await stat(join(worktree, resolvedPath));
        out.set(resolvedPath, `??:${s.mtimeMs}:${s.size}`);
      } catch {
        out.set(resolvedPath, code);
      }
    } else {
      out.set(resolvedPath, code);
    }
  }
  return out;
}

/** Paths whose status code appeared, vanished, or changed between two snapshots. */
function diffStatus(before: Map<string, string>, after: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [p, code] of after) if (before.get(p) !== code) out.add(p);
  for (const p of before.keys()) if (!after.has(p)) out.add(p);
  return [...out].sort();
}

function findingText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '(no finding payload recorded)';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '(unprintable finding payload)';
  }
}

// ---------------------------------------------------------------------------
// Test-file rule (live case 2026-11-06: the executor changed `toBe(5)` →
// `toBe(6)` in a test 3/3 times and never touched the source).
//
// A test file being in the plan's `filesToTouch` does NOT authorize editing
// it — when the finding IS a failing test, the planner lists the test file
// as a target, and that alone must never license weakening its assertions.
// Authorization is an explicit sub-step that says to ADD tests in a named
// test file ("Add new test(s) in test/adder.test.ts"). The flag lives in
// `subSteps` text rather than a plan field because `boundPlan` in
// `daemon.ts` (which this file must not change) rebuilds the plan with only
// its four known fields, so an extra field would be stripped before it ever
// reached this guard. The planner prompt (planner.ts) instructs the model
// to write the sub-step in exactly this form.
//
// Rule, in order:
// - Unauthorized test-file write → refused. Test files are read-only.
// - Authorized write to a test file that does not exist yet → allowed
//   (creating the new test file the plan asked for).
// - Authorized write to an EXISTING test file → allowed only for a purely
//   additive str_replace/multi_edit: every edit's new text must contain its
//   old text verbatim (an anchor plus appended tests) and must not introduce
//   a skip/only marker. Overwrites (`write_file`), range replacements
//   (`replace_lines`), and shell writes can never prove they only added, so
//   they are refused on existing test files.
// - Anything the guard cannot prove additive is refused here; the
//   verification pipeline is the backstop for what slips through (e.g. an
//   edit that comments an assertion out still contains the old text —
//   Stage 0 flags it as a removed expectation / assertion-count drop).
// ---------------------------------------------------------------------------

/** Sub-step language that authorizes adding tests: an add-test verb + test(s)/assertion(s)/coverage, naming the file. Verbs cover natural planner phrasing ("strengthen the test with a negative case"), not just "add a test". */
const ADD_TEST_STEP =
  /\b(add|create|write|strengthen|extend|expand|introduce|include|append)\b[^.\n]{0,120}?\b(tests?|assertions?|coverage)\b/i;

/** Test files the plan explicitly authorizes the executor to ADD tests to. */
export function authorizedTestFiles(plan: TaskExecutionPlan): Set<string> {
  const out = new Set<string>();
  const testFiles = plan.filesToTouch.filter(isTestFilePath);
  for (const file of testFiles) {
    const base = file.split('/').pop() ?? file;
    const named = plan.subSteps.some((step) => {
      // Strip the file mention before matching, so the word "test" in the
      // path itself ("Add the missing import in test/adder.test.ts") cannot
      // count as the "add a test" trigger.
      const stripped = step.split(file).join(' ').split(base).join(' ');
      return (step.includes(file) || step.includes(base)) && ADD_TEST_STEP.test(stripped);
    });
    if (named) out.add(file);
  }
  // Fallback: a step that reads as "add/strengthen tests" but names no file
  // ("Strengthen the test with a negative case") authorizes the single test
  // file in scope — unambiguous when exactly one test file is touched, which
  // is the usual failing-test finding. With several test files in scope the
  // step is ambiguous and authorizes nothing. The file mention is stripped
  // before matching here too, so "Add the missing import in
  // test/adder.test.ts" still does not authorize.
  const single = testFiles.length === 1 ? testFiles[0] : undefined;
  if (out.size === 0 && single !== undefined) {
    const base = single.split('/').pop() ?? single;
    const generic = plan.subSteps.some((step) => {
      const stripped = step.split(single).join(' ').split(base).join(' ');
      return ADD_TEST_STEP.test(stripped);
    });
    if (generic) out.add(single);
  }
  return out;
}

/** Skip/only markers an added edit must never introduce. */
const SKIP_ONLY_IN_EDIT =
  /\b((it|test|describe|suite)\s*\.\s*(skip|only)|xit|xtest|xdescribe|fit|fdescribe)\b/;

/** True when the edit only inserts text: the new text contains the old text verbatim and adds no skip/only marker. */
export function isPureInsertion(oldText: string, newText: string): boolean {
  return newText.includes(oldText) && !SKIP_ONLY_IN_EDIT.test(newText);
}

const OLD_TEXT_KEYS = [
  'old_str',
  'old_text',
  'old_string',
  'oldText',
  'old',
  'search',
  'find',
  'before',
];
const NEW_TEXT_KEYS = [
  'new_str',
  'new_text',
  'new_string',
  'newText',
  'new',
  'replace',
  'replacement',
  'after',
];

function pickString(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Old/new text pairs of an edit call (`str_replace`, `multi_edit.edits[]`); empty when the call carries no edit text. */
function editPairs(input: unknown): { oldText: string; newText: string }[] {
  if (typeof input !== 'object' || input === null) return [];
  const pairs: { oldText: string; newText: string }[] = [];
  const one = (o: unknown): void => {
    if (typeof o !== 'object' || o === null) return;
    const r = o as Record<string, unknown>;
    const oldText = pickString(r, OLD_TEXT_KEYS);
    const newText = pickString(r, NEW_TEXT_KEYS);
    if (oldText !== undefined && newText !== undefined) pairs.push({ oldText, newText });
  };
  one(input);
  const edits = (input as Record<string, unknown>).edits;
  if (Array.isArray(edits)) for (const e of edits) one(e);
  return pairs;
}

/**
 * The test-file rule inside `guardCall` (the plan-membership check has
 * already passed). `input` is the tool call's input, or undefined for a
 * bash write target, where no edit text exists to prove additivity.
 * Returns an error string when the write must not run; undefined when it may.
 */
function checkTestFileWrite(
  ctx: TaskAgentContext,
  _worktree: string,
  rel: string,
  input: unknown,
): string | undefined {
  if (!authorizedTestFiles(ctx.plan).has(rel)) {
    return (
      `refused: ${rel} is a test file and the plan does not explicitly authorize adding tests there ` +
      `— test files are read-only to the executor unless a plan sub-step says to add new tests in that file; ` +
      `never change or remove an existing test expectation, fix the source instead`
    );
  }
  // A test file that did not exist when this task started is the agent's own draft;
  // allow writing and refining it freely during implementation.
  if (!ctx.initialTestFiles.has(rel)) return undefined;

  const pairs = editPairs(input);
  if (pairs.length === 0) {
    return (
      `refused: ${rel} is an existing test file — only str_replace/multi_edit edits that purely ADD new tests are allowed ` +
      `(no overwrites, no range replacements, no shell writes); the edit must keep every existing line unchanged`
    );
  }
  for (const { oldText, newText } of pairs) {
    if (!isPureInsertion(oldText, newText)) {
      return (
        `refused: ${rel} is an existing test file — the edit changes existing test text; ` +
        `only adding new tests is allowed, never changing or removing an existing expectation ` +
        `(use str_replace with an anchor line and append the new test after it)`
      );
    }
  }
  return undefined;
}

export class AgentTaskExecutor implements TaskExecutor {
  private readonly repoRoot: string;
  private readonly provider: Provider;
  private readonly models: readonly ResolvedModel[];
  private readonly config: OmnexxConfig;
  private readonly clock: Clock;
  private readonly logger: DaemonLogger;
  private readonly onUsage: DaemonUsageRecorder | undefined;
  private readonly contexts = new Map<string, TaskAgentContext>();

  constructor(opts: AgentTaskExecutorOptions) {
    this.repoRoot = opts.repoRoot;
    this.provider = opts.provider;
    this.models = opts.models;
    this.config = opts.config;
    this.clock = opts.clock ?? realClock;
    this.logger = opts.logger ?? console;
    this.onUsage = opts.onUsage;
  }

  disposeTaskContext(taskId: string): void {
    this.contexts.delete(taskId);
  }

  async executeTurn(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    turn: number,
    signal: AbortSignal,
    onToolCall: (call: ToolCallRecord) => void | Promise<void>,
    nudge?: string,
  ): Promise<TurnResult> {
    throwIfAborted(signal);
    const worktree = task.worktreePath ?? this.repoRoot;
    const ctx = await this.contextFor(task, plan, worktree, signal);
    ctx.toolCtx.turn = turn;
    ctx.toolCtx.signal = signal;

    const before = await porcelainStatus(worktree);
    const finish = async (partial: Omit<TurnResult, 'mutatedFiles'>): Promise<TurnResult> => {
      const after = await porcelainStatus(worktree);
      return {
        done: partial.done,
        isReadOnly: partial.isReadOnly,
        mutatedFiles: diffStatus(before, after),
        toolCalls: partial.toolCalls,
        ...(partial.treeHash !== undefined ? { treeHash: partial.treeHash } : {}),
        ...(partial.error !== undefined ? { error: partial.error } : {}),
      };
    };

    // Turn 1: the plan + finding + instructions. Later turns continue the
    // conversation; a nudge (if any) is appended as a user message.
    if (ctx.messages.length === 0) {
      ctx.messages.push({
        role: 'user',
        content: [{ type: 'text', text: this.firstPrompt(task, plan, worktree) }],
      });
    } else if (nudge?.trim()) {
      ctx.messages.push({ role: 'user', content: [{ type: 'text', text: nudge.trim() }] });
    }

    let res: CompletionResponse;
    try {
      res = await this.completeOnce(ctx, task.taskId, turn, signal);
    } catch (err) {
      throwIfAborted(signal);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[executor] turn ${turn} of ${task.taskId} failed: ${message}`);
      return finish({
        done: false,
        isReadOnly: true,
        toolCalls: [],
        error: { message: clip(message, MAX_ERROR_CHARS) },
      });
    }

    ctx.messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    const text = res.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (res.stopReason === 'refusal') {
      return finish({
        done: false,
        isReadOnly: true,
        toolCalls: [],
        error: {
          message: clip(`model refused the request: ${text || '(no text)'}`, MAX_ERROR_CHARS),
        },
      });
    }

    // Text-only turn: the model believes the work is complete. Done is the
    // model's claim only — the daemon's VERIFY stage is what checks it.
    if (calls.length === 0) {
      this.trimHistory(ctx);
      return finish({ done: true, isReadOnly: true, toolCalls: [] });
    }

    // Execute the tool calls in order, one at a time: a daemon turn is
    // bounded and sequential is the safe order for writes (the loop's
    // parallel path is an interactive-turn optimisation this driver skips).
    const toolCalls: ToolCallRecord[] = [];
    const results: ContentBlock[] = [];
    let anyMutating = false;
    for (const call of calls) {
      throwIfAborted(signal);
      const { result, record, mutated } = await this.runToolCall(ctx, call);
      if (mutated) anyMutating = true;
      toolCalls.push(record);
      results.push(result);
      await onToolCall(record);
    }
    ctx.messages.push({
      role: 'user',
      content: results.map((b) =>
        b.type === 'tool_result' ? { ...b, content: clip(b.content, MAX_TOOL_RESULT_CHARS) } : b,
      ),
    });
    this.trimHistory(ctx);

    // A meaningful tree hash needs the staged tree (plain `git write-tree`
    // only sees the index, so unstaged edits would hash as HEAD and the
    // breaker would false-trip on the repeat). `workingTreeDiff` stages into
    // a throwaway index, so the real index is untouched. Only computed when
    // this turn changed files — otherwise the daemon recomputes the same
    // stale value itself, so omitting it is the honest signal.
    let treeHash: string | undefined;
    const mutatedFiles = diffStatus(before, await porcelainStatus(worktree));
    if (mutatedFiles.length > 0) {
      try {
        treeHash = (await workingTreeDiff(worktree, task.baseCommitSha ?? 'HEAD')).treeHash;
      } catch (err) {
        this.logger.warn(
          `[executor] tree hash failed for ${task.taskId}: ${(err as Error).message}`,
        );
      }
    }
    return {
      done: false,
      isReadOnly: !anyMutating,
      mutatedFiles,
      toolCalls,
      ...(treeHash !== undefined ? { treeHash } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Per-task context
  // -------------------------------------------------------------------------

  private async contextFor(
    task: QueuedTask,
    plan: TaskExecutionPlan,
    worktree: string,
    signal: AbortSignal,
  ): Promise<TaskAgentContext> {
    const existing = this.contexts.get(task.taskId);
    if (
      existing?.worktree === worktree &&
      existing.plan.filesToTouch.join('\n') === plan.filesToTouch.join('\n') &&
      existing.plan.verificationCommand === plan.verificationCommand
    ) {
      return existing;
    }
    if (existing) this.contexts.delete(task.taskId);

    const allTools = await workerTools(this.config, { repoRoot: worktree, env: process.env }, {});
    const tools = buildToolListSync(
      allTools,
      this.config,
      { subagents: false, hasHistory: false, autoApprove: false, lazyTools: false },
      null,
    ).filter((t) => DAEMON_TOOLS.includes(t.name));
    const specs = tools.map(toolSpec);
    const byName = new Map(tools.map((t) => [t.name, t]));

    // Harness-side run state for the tools that need it (bash logs, notes):
    // a real RunStore under $OMNEXX_HOME/runs, like every other run — never
    // inside the worktree, or the tools' own log files would show up as
    // task mutations.
    const store = new RunStore(resolvePaths(), `daemon-${task.taskId}`);
    await store.init();
    const redactor = Redactor.fromEnv(process.env);
    const events = new EventLog(store.eventsPath, store.runId, redactor, this.clock);
    const edited = new Set<string>();
    const tmpDir = join('/tmp', `omnexx-daemon-${task.taskId}`);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });

    const gate = new ContractGate(worktree);
    if (plan.filesToTouch.length > 0) {
      // The contract schema caps files at 20 and the hypothesis at 2_000
      // chars; a plan outside those bounds still gets the pre-execution
      // guard below, so a bad contract never fails the turn.
      try {
        gate.registerContract({
          targetFiles: plan.filesToTouch.slice(0, 20),
          hypothesis: `Daemon task ${task.taskId}: ${plan.summary || 'implement the plan'}`.slice(
            0,
            2000,
          ),
          verificationCommand: plan.verificationCommand.slice(0, 1000),
        });
      } catch (err) {
        this.logger.warn(
          `[executor] contract gate not registered for ${task.taskId}: ${(err as Error).message}`,
        );
      }
    }

    const maxCmdTimeoutMs = Math.max(30_000, parseDuration(this.config.budget.max_cmd_timeout));
    let cmdCounter = 0;
    const toolCtx: ToolContext = {
      jail: new PathJail(worktree),
      exec: runShell,
      env: daemonEnv(process.env),
      store,
      events,
      redactor,
      policy: {
        root: worktree,
        home: process.env.HOME ?? '/nonexistent',
        allowNetwork: this.config.policy.allow_network,
        extraDeny: this.config.policy.deny,
        scratch: [tmpDir],
      },
      cycle: 1,
      maxCmdTimeoutMs,
      notesMaxTokens: this.config.context.notes_max_tokens,
      today: new Date(this.clock.now()).toISOString().slice(0, 10),
      signal,
      nextCommandId: () => `cmd-1-${++cmdCounter}`,
      edited,
      reads: new Map(),
      contractGate: gate,
    };
    const initialTestFiles = new Set<string>();
    for (const file of plan.filesToTouch) {
      if (isTestFilePath(file) && existsSync(join(worktree, file))) {
        initialTestFiles.add(file.split('/').filter(Boolean).join('/'));
      }
    }
    const ctx: TaskAgentContext = {
      taskId: task.taskId,
      plan,
      worktree,
      initialTestFiles,
      messages: [],
      system: [
        { text: getWorkerPrompt(workModeOf(this.config)) },
        { text: this.daemonSystemBlock(plan, worktree) },
      ],
      tools,
      specs,
      byName,
      toolCtx,
      store,
      edited,
      spentUsd: 0,
    };
    this.contexts.set(task.taskId, ctx);
    return ctx;
  }

  private daemonSystemBlock(plan: TaskExecutionPlan, worktree: string): string {
    const files =
      plan.filesToTouch.length > 0
        ? plan.filesToTouch.map((f) => `- ${f}`).join('\n')
        : '(none — this task must not edit any file)';
    return [
      'You are working for the autonomous daemon, unattended, inside an isolated git worktree.',
      `Worktree: ${worktree}`,
      'Rules for this task (the harness enforces them; a refused call comes back as a tool error, so do not retry it):',
      '- Edit ONLY the files the plan lists:',
      files,
      '- Never touch CI, lockfiles, omnexx.toml, .env, credentials, or anything under .omnexx/ or .git/.',
      '- Never change an existing test file: test files are read-only unless the plan explicitly says to add new tests there — and even then, only ADD new tests; never change or remove an existing expectation. Fix the source, not the test.',
      '- Never run a command that writes outside the worktree, fetches from the network, or pushes.',
      `- Before you finish, run the verification command with bash: \`${plan.verificationCommand}\``,
      '- When the work is done (or you are blocked), stop calling tools and reply with a short summary: what changed, what you verified, what is left. Do not claim done merely because the verification passed — the harness verifies separately.',
    ].join('\n');
  }

  private firstPrompt(task: QueuedTask, plan: TaskExecutionPlan, worktree: string): string {
    const steps =
      plan.subSteps.length > 0
        ? plan.subSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '(no sub-steps)';
    const files =
      plan.filesToTouch.length > 0
        ? plan.filesToTouch.map((f) => `- ${f}`).join('\n')
        : '(none — read-only task)';
    return [
      `# Autonomous task ${task.taskId}`,
      '',
      `Finding (${task.sourceCollector}):`,
      findingText(task.findingPayload),
      '',
      '## Plan',
      plan.summary,
      '',
      'Sub-steps:',
      steps,
      '',
      'Files you may touch:',
      files,
      '',
      `Verification command: \`${plan.verificationCommand}\``,
      '',
      `Implement the plan in the worktree at ${worktree}. Start by reading the files the plan names, make the smallest change that implements it, then run the verification command and fix failures instead of weakening checks.`,
    ].join('\n');
  }

  /**
   * Drop whole turns from the middle of the history (the turn-1 anchor stays
   * first, so the plan is never lost). Dropping in assistant+tool-result
   * pairs keeps every `tool_use` block paired with its result, which the
   * providers require. A simple truncation — no compactor.
   */
  private trimHistory(ctx: TaskAgentContext): void {
    while (ctx.messages.length > MAX_HISTORY_MESSAGES) {
      // messages[0] is the anchor; drop the oldest complete turn (pair).
      ctx.messages.splice(1, 2);
    }
  }

  // -------------------------------------------------------------------------
  // One provider call with failover across the worker chain
  // -------------------------------------------------------------------------

  private async completeOnce(
    ctx: TaskAgentContext,
    taskId: string,
    turn: number,
    signal: AbortSignal,
  ): Promise<CompletionResponse> {
    const maxTokens = this.config.providers.anthropic.max_tokens;
    const order = callOrder(this.models, strategyFor(this.config.models, 'worker'));
    if (order.length === 0) {
      throw new ProviderError('empty model chain', { retryable: false });
    }
    // Snapshot: the provider gets a copy, so appending the reply to the live
    // conversation afterwards cannot rewrite the request it already saw.
    const snapshot = [...ctx.messages];
    const errors: string[] = [];
    for (const model of order) {
      const estimate =
        estimateTokens(JSON.stringify([ctx.system, ctx.specs, snapshot])) + maxTokens;
      const pf = preflight(this.config.budget, {
        spentUsd: ctx.spentUsd,
        cycle: { turns: turn - 1, tokens: 0 },
        estimatedInputTokens: estimate,
        maxOutputTokens: maxTokens,
        price: model.price,
      });
      if (!pf.ok) {
        throw new Error(`budget refused the turn: ${pf.detail}`);
      }
      try {
        const res = await this.provider.complete({
          ...turnRequest(
            { system: ctx.system, tools: ctx.specs },
            snapshot,
            model.id,
            maxTokens,
            `daemon-${taskId}`,
          ),
          route: model.provider,
          signal,
        });
        ctx.spentUsd += costUsd(res.usage, model.price);
        // Report the priced call to the budget ledger (via the recorder the
        // wiring layer injected); the per-task preflight above only tracks
        // spend in memory, it never persists it.
        const totals = usageTokenTotals(res.usage);
        this.onUsage?.({
          taskId,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          usd: costUsd(res.usage, model.price),
        });
        return res;
      } catch (err) {
        if (signal.aborted) throw err;
        if (!shouldFailover(err)) throw err;
        errors.push(`${model.provider}:${model.id}: ${(err as Error).message}`);
        this.logger.warn(
          `[executor] failover from ${model.provider}:${model.id}: ${(err as Error).message}`,
        );
      }
    }
    throw new ProviderError(`no provider in the chain could take the call: ${errors.join('; ')}`, {
      retryable: true,
    });
  }

  // -------------------------------------------------------------------------
  // One tool call: guard → validate → run (mirrors the agent loop's runCall)
  // -------------------------------------------------------------------------

  private resolveTool(byName: ReadonlyMap<string, Tool>, name: string): Tool | undefined {
    return byName.get(name) ?? byName.get(TOOL_ALIASES[name.toLowerCase()] ?? '');
  }

  /**
   * Pre-execution guard. Returns an error string when the call must not run
   * (the caller turns it into an error tool result); undefined when it may.
   */
  private guardCall(
    ctx: TaskAgentContext,
    tool: Tool | undefined,
    input: unknown,
  ): string | undefined {
    if (!tool) return undefined; // unknown tool: handled by the caller.
    const worktree = ctx.worktree;
    const planFiles = new Set(
      ctx.plan.filesToTouch.map((f) => f.split('/').filter(Boolean).join('/')),
    );
    const mode = tool.readOnly ? 'read' : 'write';

    const checkFile = (p: string): string | undefined => {
      const rel = relPosix(worktree, p);
      if (rel === undefined) {
        return `refused: ${p} is outside the worktree`;
      }
      try {
        assertPathAllowed(rel, mode);
      } catch (err) {
        return `refused: ${(err as Error).message}`;
      }
      if (!tool.readOnly && !planFiles.has(rel)) {
        return (
          `refused: ${rel} is not in the task plan's filesToTouch ` +
          `[${ctx.plan.filesToTouch.join(', ')}] — edit only plan files`
        );
      }
      if (!tool.readOnly && isTestFilePath(rel)) {
        return checkTestFileWrite(ctx, worktree, rel, tool.name === 'bash' ? undefined : input);
      }
      return undefined;
    };

    for (const p of pathsFromInput(input)) {
      const refused = checkFile(p);
      if (refused) return refused;
    }

    if (tool.name === 'bash' && typeof input === 'object' && input !== null) {
      const command = (input as Record<string, unknown>).command;
      if (typeof command === 'string') {
        try {
          assertDaemonCommand(command, ctx.toolCtx.policy);
        } catch (err) {
          return `refused: ${(err as Error).message}`;
        }
        for (const target of bashWriteTargets(command)) {
          const refused = checkFile(target);
          if (refused) return refused;
        }
      }
    }
    return undefined;
  }

  private async runToolCall(
    ctx: TaskAgentContext,
    call: Extract<ContentBlock, { type: 'tool_use' }>,
  ): Promise<{ result: ContentBlock; record: ToolCallRecord; mutated: boolean }> {
    const inputSummary = summarizeInput(call.input);
    const errorResult = (
      content: string,
    ): { result: ContentBlock; record: ToolCallRecord; mutated: boolean } => ({
      result: { type: 'tool_result', toolUseId: call.id, content, isError: true },
      record: {
        toolName: call.name,
        ...(inputSummary ? { inputSummary } : {}),
        errorContent: clip(content, MAX_ERROR_CHARS),
      },
      mutated: false,
    });

    const tool = this.resolveTool(ctx.byName, call.name);
    const refused = this.guardCall(ctx, tool, call.input);
    if (refused) return errorResult(refused);
    if (!tool) {
      return errorResult(
        `unknown tool ${call.name}; the tools are: ${[...ctx.byName.keys()].join(', ')}`,
      );
    }

    const prepare = (v: unknown): unknown => (tool.normalize ? tool.normalize(v) : v);
    let parsed = tool.schema.safeParse(prepare(call.input));
    if (!parsed.success) {
      const decoded = decodeJsonStrings(call.input);
      if (decoded !== call.input) {
        const again = tool.schema.safeParse(prepare(decoded));
        if (again.success) parsed = again;
      }
    }
    if (!parsed.success) {
      const lenient = lenientInput(tool.schema, call.input);
      if (lenient !== undefined) {
        const again = tool.schema.safeParse(prepare(lenient));
        if (again.success) parsed = again;
      }
    }
    if (!parsed.success) {
      return errorResult(
        `invalid input for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    let out: ToolOutput;
    try {
      out = await tool.run(parsed.data, ctx.toolCtx);
    } catch (err) {
      return errorResult(`tool ${call.name} threw: ${(err as Error).message}`);
    }
    const content = ctx.toolCtx.redactor.text(out.content);
    const isError = out.isError === true;
    return {
      result: {
        type: 'tool_result',
        toolUseId: call.id,
        content,
        ...(isError ? { isError: true } : {}),
      },
      record: {
        toolName: call.name,
        ...(inputSummary ? { inputSummary } : {}),
        ...(isError ? { errorContent: clip(content, MAX_ERROR_CHARS) } : {}),
      },
      mutated: !tool.readOnly,
    };
  }
}

/**
 * Factory for the wiring worker: the worker chain comes from the config
 * (`models.worker`), exactly as `Run` resolves it.
 */
export function createTaskExecutor(opts: {
  provider: Provider;
  config: OmnexxConfig;
  repoRoot: string;
  logger?: DaemonLogger;
  onUsage?: DaemonUsageRecorder;
}): AgentTaskExecutor {
  return new AgentTaskExecutor({
    ...opts,
    models: resolveChain(opts.config.models.worker, opts.config),
  });
}

// ---------------------------------------------------------------------------
// Reuse ledger (for the coordinator's "no second agent loop" check)
//
// Reused from the existing run path:
// - `turnRequest` (src/agent/context.ts) builds the provider request with
//   cache breakpoints — the same request the loop sends.
// - `workerTools` + `buildToolListSync` + `toolSpec` (src/tools/registry.ts)
//   build the Tool[] list and provider specs, rooted at the task worktree.
// - `ToolContext` (src/tools/types.ts) is built the same way `toolContext`
//   in src/core/cycle.ts builds it: PathJail(worktree), runShell exec,
//   RunStore + EventLog + Redactor, PolicyContext, ContractGate.
// - `ContractGate` (src/core/contract.ts) enforces plan file membership
//   inside the edit tools themselves.
// - `checkDaemonCommand` / `assertPathAllowed` / `daemonEnv`
//   (src/autonomous/tool-guard.ts) enforce the daemon denylist, shell
//   firewall, and secret-stripped child env.
// - `callOrder` + `strategyFor` (src/config/routing.ts) order the failover
//   chain; `shouldFailover` (src/providers/router.ts) decides failover;
//   `preflight` (src/guard/budget.ts) refuses over-budget calls.
// - `decodeJsonStrings` + `lenientInput` (src/agent/loop.ts) are the loop's
//   own input-repair fallbacks for tool-call validation.
// - `getWorkerPrompt` (src/agent/prompts.ts) is the run's worker system
//   prompt; `statusPorcelain` + `workingTreeDiff` (src/git/repo.ts) detect
//   mutated files and the staged tree hash.
//
// Written here (the thin single-turn driver):
// - The one-provider-call-per-turn driver (`completeOnce`), the per-task
//   conversation store + history trimming, the turn-1 prompt, the sequential
//   tool-call runner (`runToolCall`), and the pre-execution guard
//   (`guardCall`, `bashWriteTargets`). `runAgentLoop` itself was NOT reused:
//   it has no turn cap of 1 (its single turn becomes a terminal synthesis
//   turn with `toolChoice: 'none'`), and it drags in compaction, rolling
//   memory, stuck watch, kernel, doom ratchet, and control polling the
//   daemon already owns. The daemon is the multi-turn loop; this class is
//   one turn of it.
//
// Known gaps (not hidden):
// - `childPgid` is never set: the bash tool runs commands through
//   `runShell`, whose `ExecResult` carries no pgid, so the watchdog cannot
//   kill a hung child process group by pgid — the bash tool's own timeout
//   (`maxCmdTimeoutMs`) is the backstop.
// - Bash sessions are process-global (`main` / `test` in src/tools/bash.ts),
//   so two daemon tasks in one process share a shell session's cwd/env.
//   Same property as the normal run path; isolating it needs a change to
//   the bash tool, not this driver.
// - The bash redirect/`tee` target check is best-effort parsing; a command
//   that writes a file through an exotic construct (e.g. `python -c` with an
//   open() call) is caught only by the command policy / jail, not by plan
//   membership. The edit tools — the normal way code changes — are fully
//   gated by ContractGate + the pre-execution guard.
// ---------------------------------------------------------------------------
