import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where an omnexx run's time and tokens went, from its events.jsonl: model turns, tool calls per
 * turn, bookkeeping share, time in gates, idle time and the token mix. Other harnesses write no
 * events, so their rows have no efficiency.
 */
export interface RunEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export interface Efficiency {
  /** Model calls (`turn` events). */
  turns: number;
  /** Tool calls made. */
  tool_calls: number;
  /** Tool calls per turn that asked for any. */
  calls_per_turn: number;
  /** Turns that asked for more than one tool. */
  multi_call_turns: number;
  /** Share of tool calls that only keep notes (see BOOKKEEPING_TOOLS). */
  bookkeeping_share: number;
  /** Wall time spent in gates, reruns included. */
  gate_ms: number;
  /** Wall time with nothing running: gaps over IDLE_GAP_MS that no model call, tool or gate covers. */
  idle_ms: number;
  /** Uncached input (cache writes included) per turn. */
  fresh_per_turn: number;
  /** Share of input tokens read from the cache. */
  cache_share: number;
}

/** Tools that record state for the agent or the person watching, and change no code. */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  'todo',
  'running_context',
  'remember',
  'context',
  'recall',
]);

/** A gap shorter than this is the harness thinking between steps, not idling. */
export const IDLE_GAP_MS = 60_000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** How long the work that ended at `e` ran, so a long model call or test run isn't idle. */
function coveredMs(e: RunEvent): number {
  if (e.type === 'turn' || e.type === 'tool.call' || e.type === 'loop.gates') return num(e.ms);
  if (e.type === 'verify.gates' && Array.isArray(e.gates))
    return (e.gates as { durationMs?: unknown }[]).reduce((s, g) => s + num(g.durationMs), 0);
  return 0;
}

function gateMs(e: RunEvent): number {
  return e.type === 'loop.gates' || e.type === 'verify.gates' ? coveredMs(e) : 0;
}

/**
 * Efficiency of one run. `span` is the bench's own start and end, so time before the first
 * event or after the last one (a run that went quiet until it was killed) counts as idle too.
 */
export function efficiency(
  events: readonly RunEvent[],
  span?: { start: number; end: number },
): Efficiency | undefined {
  const sorted = [...events].filter((e) => Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  if (!sorted.length) return undefined;

  let turns = 0;
  let toolCalls = 0;
  let bookkeeping = 0;
  let gate = 0;
  let idle = 0;
  let fresh = 0;
  let cached = 0;
  const perTurn: number[] = [];

  let prev = span ? Math.min(span.start, sorted[0]?.ts ?? span.start) : sorted[0]?.ts;
  for (const e of sorted) {
    if (prev !== undefined) {
      const open = e.ts - prev - coveredMs(e);
      if (open > IDLE_GAP_MS) idle += open;
    }
    prev = e.ts;
    gate += gateMs(e);
    if (e.type === 'turn') {
      turns++;
      perTurn.push(0);
      const t = (e.tokens ?? {}) as Record<string, unknown>;
      fresh += num(t.uncached) + num(t.cacheWrite);
      cached += num(t.cacheRead);
    } else if (e.type === 'tool.call') {
      toolCalls++;
      if (BOOKKEEPING_TOOLS.has(String(e.tool))) bookkeeping++;
      if (perTurn.length) perTurn[perTurn.length - 1] = (perTurn.at(-1) ?? 0) + 1;
    }
  }
  if (span && prev !== undefined && span.end - prev > IDLE_GAP_MS) idle += span.end - prev;

  const toolTurns = perTurn.filter((n) => n > 0);
  const round = (v: number, places: number): number => Number(v.toFixed(places));
  return {
    turns,
    tool_calls: toolCalls,
    calls_per_turn: toolTurns.length ? round(toolCalls / toolTurns.length, 2) : 0,
    multi_call_turns: toolTurns.filter((n) => n > 1).length,
    bookkeeping_share: toolCalls ? round(bookkeeping / toolCalls, 3) : 0,
    gate_ms: gate,
    idle_ms: idle,
    fresh_per_turn: turns ? Math.round(fresh / turns) : 0,
    cache_share: fresh + cached ? round(cached / (fresh + cached), 3) : 0,
  };
}

/** Time-budget metrics derived from a run's `time.report` events. */
export function timeMetrics(
  events: readonly RunEvent[],
  wallMs: number,
):
  | { on_budget: boolean; overrun_ms: number; active_ratio: number; useful_ops_per_hour: number }
  | undefined {
  const reports = events.filter((e) => e.type === 'time.report');
  if (!reports.length) return undefined;
  const last = reports[reports.length - 1]!;
  const elapsedS = num(last.elapsed_s);
  const overrunS = num(last.overrun_s);
  const usefulOps = num(last.useful_ops);
  const activeRatio = wallMs > 0 ? Math.min(1, (elapsedS * 1000) / wallMs) : 0;
  const hours = elapsedS / 3600;
  return {
    on_budget: overrunS === 0,
    overrun_ms: overrunS * 1000,
    active_ratio: Number(activeRatio.toFixed(3)),
    useful_ops_per_hour: hours > 0 ? Number((usefulOps / hours).toFixed(2)) : 0,
  };
}
/** A saved run log's events, oldest first; [] when there is none or a line doesn't parse. */
export async function readRunEvents(runDir: string): Promise<RunEvent[]> {
  const text = await readFile(join(runDir, 'events.jsonl'), 'utf-8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as RunEvent;
        return typeof e.ts === 'number' && typeof e.type === 'string' ? [e] : [];
      } catch {
        return [];
      }
    });
}
