/**
 * Worker backends (plan §15): other coding harnesses Omnexx can hand one scoped task to. The
 * plugin only knows how to detect, invoke and read its tool; the harness owns the worktree,
 * the process, the env, the timeout, the diff and the judge. Real adapters arrive in M3.
 */

export const WORKER_STATUSES = [
  'completed',
  'failed',
  'timeout',
  'quota_exhausted',
  'rate_limited',
  'auth_required',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface WorkerDetection {
  installed: boolean;
  path?: string;
  version?: string;
  /** Capability flags parsed from `--help` (e.g. "json-output"). */
  capabilities: string[];
}

export interface WorkerTask {
  id: string;
  title: string;
  acceptance: string[];
  checks: string[];
  evidence: string[];
}

export interface InvocationContext {
  /** The isolated worktree the worker runs in (cwd). */
  worktree: string;
  /** Prompt written by the harness; use it when the tool takes a file. */
  promptFile: string;
  prompt: string;
}

export interface WorkerInvocation {
  argv: string[];
  /** Added on top of the scrubbed environment. Never supervisor secrets. */
  env: Record<string, string>;
  stdin?: string;
}

export interface WorkerOutcome {
  status: WorkerStatus;
  summary?: string;
  usage?: { usd?: number; inputTokens?: number; outputTokens?: number };
}

export interface QuotaPolicy {
  maxRunsPerHour: number;
  maxRunsPerDay: number;
  cooldownMs: number;
}

export interface WorkerBackend {
  readonly id: string;
  readonly displayName: string;
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy;
  detect(): Promise<WorkerDetection>;
  buildInvocation(task: WorkerTask, ctx: InvocationContext): WorkerInvocation;
  parseResult(exitCode: number, stdoutPath: string, stderrPath: string): Promise<WorkerOutcome>;
}
