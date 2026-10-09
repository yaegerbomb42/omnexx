import type { OmnexxEvent } from '../core/events.js';

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
      const k = (e.tokens ?? {}) as Record<string, unknown>;
      t.turns++;
      t.tokens.input += n(k.uncached) + n(k.cacheWrite) + n(k.cacheRead);
      t.tokens.cacheRead += n(k.cacheRead);
      t.tokens.cacheWrite += n(k.cacheWrite);
      t.tokens.output += n(k.output);
      t.usd += n(e.usd);
      if (typeof e.model === 'string') t.model = e.model;
      if (typeof e.provider === 'string') t.provider = e.provider;
      break;
    }
    case 'tool.call':
      t.toolCalls++;
      if (e.isError) t.toolErrors++;
      break;
    case 'verify.gates':
      for (const g of Array.isArray(e.gates) ? (e.gates as Record<string, unknown>[]) : []) {
        t.gateRuns++;
        if (n(g.exitCode) === 0) t.gatePasses++;
      }
      break;
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
