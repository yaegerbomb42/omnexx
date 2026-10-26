import type { OmnexxEvent } from '../core/events.js';

/** Tokens payload on a turn event. */
interface TurnTokens {
  uncached?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
}

/** Gate payload on verify.gates event. */
interface GatePayload {
  exitCode?: number;
}

/** Live totals folded from the event stream: the TUI header, `status --json` and the line feed footer. */
export interface Telemetry {
  startedAt?: number;
  lastAt?: number;
  cycle: number;
  task?: string;
  phase?: string;
  model?: string;
  provider?: string;
  turns: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  usd: number;
  toolCalls: number;
  toolErrors: number;
  commits: number;
  rejects: number;
  rollbacks: number;
  gateRuns: number;
  gatePasses: number;
  compactions: number;
  lastCommit?: string;
  status?: string;
  /** Calls moved to another model after an error. */
  failovers: number;
  lastFailover?: string;
  /** provider:model refs that ran out of quota during the run. */
  quotaOut: string[];
  /** How the current model was chosen: pin, judge (Nimble) or rules. */
  routeBy?: string;
  /** Stuck signals and strategy-ladder escalations. */
  stuck: number;
  milestonesDone: number;
  /** Turns whose cache read fell under 80% of the previous prompt. */
  cacheMisses: number;
}

export function emptyTelemetry(): Telemetry {
  return {
    cycle: 0,
    turns: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    usd: 0,
    toolCalls: 0,
    toolErrors: 0,
    commits: 0,
    rejects: 0,
    rollbacks: 0,
    gateRuns: 0,
    gatePasses: 0,
    compactions: 0,
    failovers: 0,
    quotaOut: [],
    stuck: 0,
    milestonesDone: 0,
    cacheMisses: 0,
  };
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Mutates and returns `t`. Unknown events only advance the clock. */
export function fold(t: Telemetry, e: OmnexxEvent): Telemetry {
  t.startedAt ??= e.ts;
  t.lastAt = e.ts;
  t.cycle = Math.max(t.cycle, e.cycle);
  switch (e.type) {
    case 'cycle.start':
      if (typeof e.task === 'string') t.task = e.task;
      break;
    case 'phase':
      if (typeof e.phase === 'string') t.phase = e.phase;
      break;
    case 'turn': {
      const tokens = (e.tokens ?? {}) as TurnTokens;
      t.turns++;
      t.tokens.input += n(tokens.uncached) + n(tokens.cacheWrite) + n(tokens.cacheRead);
      t.tokens.cacheRead += n(tokens.cacheRead);
      t.tokens.cacheWrite += n(tokens.cacheWrite);
      t.tokens.output += n(tokens.output);
      t.usd += n(e.usd);
      if (typeof e.model === 'string') t.model = e.model;
      if (typeof e.provider === 'string') t.provider = e.provider;
      break;
    }
    case 'cache.miss':
      t.cacheMisses++;
      break;
    case 'tool.call':
      t.toolCalls++;
      if (e.isError) t.toolErrors++;
      break;
    case 'verify.gates': {
      const gates = Array.isArray(e.gates) ? (e.gates as GatePayload[]) : [];
      for (const g of gates) {
        t.gateRuns++;
        if (n(g.exitCode) === 0) t.gatePasses++;
      }
      break;
    }
    case 'verify.result':
      if (e.verdict !== 'accept') t.rejects++;
      break;
    case 'commit':
      t.commits++;
      if (typeof e.sha === 'string') t.lastCommit = e.sha;
      break;
    case 'rollback':
      t.rollbacks++;
      break;
    case 'context.compacted':
      t.compactions++;
      break;
    case 'run.finish':
      if (typeof e.status === 'string') t.status = e.status;
      break;
    case 'provider.failover':
      t.failovers++;
      t.lastFailover = `${String(e.provider)}${typeof e.model === 'string' ? `:${e.model}` : ''}`;
      break;
    case 'provider.quota_exhausted':
      if (typeof e.model === 'string' && !t.quotaOut.includes(e.model)) t.quotaOut.push(e.model);
      break;
    case 'route.decision':
      if (typeof e.by === 'string') t.routeBy = e.by;
      break;
    case 'stuck.signal':
    case 'ladder.rung':
      t.stuck++;
      break;
    case 'milestone.done':
      t.milestonesDone++;
      break;
  }
  return t;
}

export function cacheHitRate(t: Telemetry): number {
  return t.tokens.input ? t.tokens.cacheRead / t.tokens.input : 0;
}

/** Input tokens spent per accepted commit: the efficiency number we optimise. */
export function tokensPerCommit(t: Telemetry): number | undefined {
  return t.commits ? Math.round((t.tokens.input + t.tokens.output) / t.commits) : undefined;
}

/**
 * Percentile calculation helper.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Per-task statistics from a run's events.
 */
export interface TaskStats {
  taskId: string;
  turns: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  usd: number;
  toolCalls: number;
  toolErrors: number;
  commits: number;
  durationMs: number;
}

/**
 * Aggregate statistics for a run, suitable for JSONL emission and `omnexx stats`.
 */
export interface RunStats {
  runId: string;
  startedAt: number;
  finishedAt: number;
  status: string;
  mode: string;
  cycles: number;
  tasks: TaskStats[];
  totals: {
    turns: number;
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    usd: number;
    toolCalls: number;
    toolErrors: number;
    commits: number;
    durationMs: number;
  };
  cacheHitRate: number;
  turnsPerTask: { p50: number; p95: number };
  latencyPerTurnMs: { p50: number; p95: number };
  tokensPerTask: { p50: number; p95: number };
}

/**
 * Folds events into per-task statistics and computes run-level aggregates including percentiles.
 * `mode` is filled by the caller (the run's execution/work mode).
 */
export function collectRunStats(events: readonly OmnexxEvent[], runId: string): RunStats {
  const tasks = new Map<string, TaskStats>();
  let currentTask: string | undefined;
  const taskSpan = new Map<string, { first: number; last: number }>();
  const turnLatencies: number[] = [];
  const tel = emptyTelemetry();

  for (const e of events) {
    fold(tel, e);
    switch (e.type) {
      case 'cycle.start':
        if (typeof e.task === 'string') {
          currentTask = e.task;
          if (!tasks.has(currentTask)) {
            tasks.set(currentTask, {
              taskId: currentTask,
              turns: 0,
              tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
              usd: 0,
              toolCalls: 0,
              toolErrors: 0,
              commits: 0,
              durationMs: 0,
            });
            taskSpan.set(currentTask, { first: e.ts, last: e.ts });
          } else {
            const span = taskSpan.get(currentTask);
            if (span) span.last = e.ts;
          }
        }
        break;
      case 'turn': {
        if (currentTask) {
          const task = tasks.get(currentTask);
          if (!task) break;
          task.turns++;
          const tokens = (e.tokens ?? {}) as TurnTokens;
          task.tokens.input += n(tokens.uncached) + n(tokens.cacheWrite) + n(tokens.cacheRead);
          task.tokens.cacheRead += n(tokens.cacheRead);
          task.tokens.cacheWrite += n(tokens.cacheWrite);
          task.tokens.output += n(tokens.output);
          task.usd += n(e.usd);
          if (typeof e.ms === 'number' && Number.isFinite(e.ms)) turnLatencies.push(e.ms);
          const span = taskSpan.get(currentTask);
          if (span) span.last = e.ts;
        }
        break;
      }
      case 'tool.call': {
        if (currentTask) {
          const task = tasks.get(currentTask);
          if (!task) break;
          task.toolCalls++;
          if (e.isError) task.toolErrors++;
          const span = taskSpan.get(currentTask);
          if (span) span.last = e.ts;
        }
        break;
      }
      case 'commit': {
        if (currentTask) {
          const task = tasks.get(currentTask);
          if (!task) break;
          task.commits++;
          const span = taskSpan.get(currentTask);
          if (span) span.last = e.ts;
        }
        break;
      }
    }
  }

  for (const [taskId, task] of tasks) {
    const span = taskSpan.get(taskId);
    if (span) task.durationMs = span.last - span.first;
  }

  const startedAt = tel.startedAt ?? events[0]?.ts ?? 0;
  const finishedAt = tel.lastAt ?? startedAt;
  const turnsPerTask = Array.from(tasks.values())
    .map((t) => t.turns)
    .sort((a, b) => a - b);
  const latencyPerTurn = [...turnLatencies].sort((a, b) => a - b);
  const tokensPerTask = Array.from(tasks.values())
    .map((t) => t.tokens.input + t.tokens.output)
    .sort((a, b) => a - b);

  return {
    runId,
    startedAt,
    finishedAt,
    status: tel.status ?? 'unknown',
    mode: '',
    cycles: tel.cycle,
    tasks: Array.from(tasks.values()),
    totals: {
      turns: tel.turns,
      tokens: tel.tokens,
      usd: tel.usd,
      toolCalls: tel.toolCalls,
      toolErrors: tel.toolErrors,
      commits: tel.commits,
      durationMs: finishedAt - startedAt,
    },
    cacheHitRate: cacheHitRate(tel),
    turnsPerTask: { p50: percentile(turnsPerTask, 50), p95: percentile(turnsPerTask, 95) },
    latencyPerTurnMs: { p50: percentile(latencyPerTurn, 50), p95: percentile(latencyPerTurn, 95) },
    tokensPerTask: { p50: percentile(tokensPerTask, 50), p95: percentile(tokensPerTask, 95) },
  };
}

/** One JSONL line per run, for log aggregation. */
export function runStatsToJsonl(stats: RunStats): string {
  return JSON.stringify(stats);
}
