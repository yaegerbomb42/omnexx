import type { z } from 'zod';
import type { EventLog } from '../core/events.js';
import type { Executor } from '../core/exec.js';
import type { RunStore } from '../core/run-store.js';
import type { PolicyContext } from '../security/command-policy.js';
import { OutsideRootError, type PathJail } from '../security/paths.js';
import type { Redactor } from '../security/redact.js';

export interface ToolContext {
  /** Where `bash` runs: the host, or the run's sandbox. */
  exec?: Executor;
  jail: PathJail;
  env: Record<string, string>;
  store: RunStore;
  events: EventLog;
  redactor: Redactor;
  policy: PolicyContext;
  cycle: number;
  maxCmdTimeoutMs: number;
  notesMaxTokens: number;
  today: string;
  signal?: AbortSignal;
  /** Counter for `cmd-<cycle>-<n>` log ids. */
  nextCommandId: () => string;
  /** Advisory pre-execution safety check (judge, log-only). Must never block. */
  onBash?: (command: string) => void;
  /** Files the agent edited this cycle (for "no edits after K turns" and reporting). */
  edited: Set<string>;
  /**
   * Content hashes of what `read` has already returned this cycle, by path and range. A repeat
   * read of unchanged content gets a one-line pointer instead of the same text again. Cleared
   * whenever old tool results are elided or compacted, since the earlier copy is then gone.
   */
  reads?: Map<string, string>;
  /**
   * Interactive chat only: ask the person at the keyboard to allow something the harness would
   * otherwise refuse (a path outside the repo, a command the policy denies). Unattended runs never
   * set it, so there nothing can be overridden.
   */
  ask?: (question: string) => Promise<boolean>;
  /** Runs a read-only child agent (the `task` tool). Unset inside a child: no recursion. */
  subagent?: (description: string, kind: SubagentKind) => Promise<string>;
}

export const SUBAGENT_KINDS = ['explore', 'research', 'review'] as const;
export type SubagentKind = (typeof SUBAGENT_KINDS)[number];

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Read-only tools are the only ones the planner gets. */
  readOnly: boolean;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export const ok = (content: string): ToolOutput => ({ content });

/** `jail.resolve`, but a path outside the repo can be allowed by the person, when `ask` is set. */
export async function resolvePath(
  ctx: ToolContext,
  path: string,
  mode: 'read' | 'write',
): Promise<string> {
  try {
    return ctx.jail.resolve(path, mode);
  } catch (err) {
    if (
      err instanceof OutsideRootError &&
      ctx.ask &&
      (await ctx.ask(`${mode} ${path}? It is outside the repo.`))
    )
      return ctx.jail.resolve(path, mode, { allowOutside: true });
    throw err;
  }
}
export const fail = (content: string): ToolOutput => ({ content, isError: true });
