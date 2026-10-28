import type { HookConfig, HookEvent } from '../config/sections/hooks.js';
import { parseDuration } from '../config/duration.js';
import { runShell, type ExecOptions, type ExecResult, type Executor } from '../core/exec.js';

/** Longest block reason fed back to the agent: the hook's output tail, trimmed. */
export const HOOK_REASON_MAX = 2_000;

/** Events whose non-zero exit vetoes the action. */
const BLOCKING = new Set<HookEvent>(['pre_tool', 'pre_commit']);

export interface HookRunResult {
  on: HookEvent;
  run: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface HooksBlocked {
  blocked: true;
  /** Trimmed hook output (stdout+stderr interleaved), fed back to the agent. */
  reason: string;
  ran: HookRunResult[];
}

export interface HooksPassed {
  blocked: false;
  ran: HookRunResult[];
}

export type HooksOutcome = HooksBlocked | HooksPassed;

export interface RunHooksOptions {
  hooks: readonly HookConfig[];
  /** Where hooks run: the worktree for repo hooks. */
  cwd: string;
  /** Full environment for the hook process; `OMNEXX_EVENT` is added on top. */
  env: Record<string, string>;
  /** Command runner; defaults to the host shell. Call sites pass the run's executor (sandbox). */
  exec?: Executor;
  signal?: AbortSignal;
  redact?: (s: string) => string;
}

/**
 * Glob with `*` (any run) and `?` (one char), anchored; every other character is literal.
 */
export function matchGlob(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(value);
}

function hookReason(hook: HookConfig, r: ExecResult): string {
  const parts: string[] = [];
  const out = r.output.trim();
  if (out) parts.push(out);
  if (r.timedOut) parts.push(`hook timed out after ${hook.timeout}`);
  if (parts.length === 0) parts.push(`hook exited ${r.exitCode} with no output`);
  const text = parts.join('\n');
  return text.length > HOOK_REASON_MAX ? `…${text.slice(-(HOOK_REASON_MAX - 1))}` : text;
}

/**
 * Run the hooks configured for `event`, in config order, via the shared command runner: the
 * payload arrives as JSON on stdin and the event name in `OMNEXX_EVENT`. On a `pre_*` event a
 * non-zero exit (or a timeout) stops the run and returns `{blocked: true, reason}` with the
 * hook's output tail (≤ 2k). `post_*` and lifecycle events never block.
 */
export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  opts: RunHooksOptions,
): Promise<HooksOutcome> {
  const exec = opts.exec ?? runShell;
  const tool = typeof payload.tool === 'string' ? payload.tool : undefined;
  const ran: HookRunResult[] = [];
  for (const hook of opts.hooks) {
    if (hook.on !== event) continue;
    if (hook.match !== undefined && tool !== undefined && !matchGlob(hook.match, tool)) continue;
    const execOpts: ExecOptions = {
      cwd: opts.cwd,
      env: { ...opts.env, OMNEXX_EVENT: event },
      timeoutMs: parseDuration(hook.timeout),
      stdin: JSON.stringify({ ...payload, event }),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.redact ? { redact: opts.redact } : {}),
    };
    const r = await exec(hook.run, execOpts);
    ran.push({
      on: event,
      run: hook.run,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
    });
    if (BLOCKING.has(event) && (r.timedOut || r.exitCode !== 0)) {
      return { blocked: true, reason: hookReason(hook, r), ran };
    }
  }
  return { blocked: false, ran };
}
