import type { z } from 'zod';
import type { EventLog } from '../core/events.js';
import type { Executor } from '../core/exec.js';
import type { RunStore } from '../core/run-store.js';
import type { PolicyContext } from '../security/command-policy.js';
import type { PathJail } from '../security/paths.js';
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
  /** Tidy model input before validation (shape slips only; meaning is still validated). */
  normalize?: (input: unknown) => unknown;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export const ok = (content: string): ToolOutput => ({ content });
export const fail = (content: string): ToolOutput => ({ content, isError: true });
