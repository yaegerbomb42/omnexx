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
}

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
export const fail = (content: string): ToolOutput => ({ content, isError: true });
