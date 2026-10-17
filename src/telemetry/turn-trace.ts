/**
 * Per-turn trace for `/trace`. Folds the events a run already emits (`turn`, `tool.call`,
 * `loop.gates`, `verify.gates`) into one closed turn. A `turn` event opens the turn; its tool
 * calls follow it, and the next `turn` (or `run.finish`) closes it.
 */

export interface TraceCall {
  tool: string;
  isError: boolean;
  error: string;
}

export type GateStatus = 'none' | 'ran' | 'ok' | 'fail';

export interface TurnTrace {
  turn: number;
  calls: readonly TraceCall[];
  /** Input tokens that were not a cache read (`uncached` + `cacheWrite`). */
  fresh: number;
  /** `cacheRead` tokens. */
  cached: number;
  ms: number;
  gates: GateStatus;
}

export interface TraceAcc {
  open: TurnTrace | undefined;
}

const EXPLORE = new Set(['read', 'outline', 'search', 'list', 'read_symbol']);
const BOOKKEEPING = new Set(['todo', 'running_context', 'remember', 'context', 'recall']);
const EDIT = new Set(['str_replace', 'edit', 'multi_edit', 'replace_lines']);

export function emptyTrace(): TraceAcc {
  return { open: undefined };
}

/** True when this turn was a single explore, notes-only, a denied command, or a failed edit. */
export function turnWarning(calls: readonly TraceCall[]): boolean {
  const one = calls.length === 1 ? calls[0] : undefined;
  if (one && EXPLORE.has(one.tool)) return true;
  if (calls.length > 0 && calls.every((c) => BOOKKEEPING.has(c.tool))) return true;
  if (calls.some((c) => c.isError && (c.tool === 'bash' || /denied/i.test(c.error)))) return true;
  if (calls.some((c) => c.isError && EDIT.has(c.tool))) return true;
  return false;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function tokensOf(e: Record<string, unknown>): { fresh: number; cached: number } {
  const t = e.tokens;
  if (!t || typeof t !== 'object') return { fresh: 0, cached: 0 };
  const o = t as Record<string, unknown>;
  return { fresh: num(o.uncached) + num(o.cacheWrite), cached: num(o.cacheRead) };
}

function verifyStatus(e: Record<string, unknown>): 'ok' | 'fail' {
  const gates = Array.isArray(e.gates) ? e.gates : [];
  const fail = gates.some((g) => {
    if (!g || typeof g !== 'object') return false;
    return num((g as Record<string, unknown>).exitCode) !== 0;
  });
  return fail ? 'fail' : 'ok';
}

function noteGates(open: TurnTrace, status: GateStatus): void {
  if (status === 'ran' && open.gates !== 'none') return;
  open.gates = status;
}

/**
 * Fold one event. Returns the turn that just closed, if this event ended it.
 * Mutates `acc` (the open turn).
 */
export function pushTrace(
  acc: TraceAcc,
  e: { type: string } & Record<string, unknown>,
): TurnTrace | undefined {
  if (e.type === 'turn') {
    const closed = acc.open;
    const tokens = tokensOf(e);
    acc.open = {
      turn: num(e.turn),
      calls: [],
      fresh: tokens.fresh,
      cached: tokens.cached,
      ms: num(e.ms),
      gates: 'none',
    };
    return closed;
  }
  const open = acc.open;
  if (!open) return undefined;
  if (e.type === 'tool.call') {
    const tool = typeof e.tool === 'string' ? e.tool : '';
    acc.open = {
      ...open,
      calls: [
        ...open.calls,
        { tool, isError: e.isError === true, error: typeof e.error === 'string' ? e.error : '' },
      ],
    };
    return undefined;
  }
  if (e.type === 'verify.gates') {
    noteGates(open, verifyStatus(e));
    return undefined;
  }
  if (e.type === 'loop.gates') {
    noteGates(open, 'ran');
    return undefined;
  }
  if (e.type === 'run.finish') {
    acc.open = undefined;
    return open;
  }
  return undefined;
}

/** Closed turns, in order. Events seen while tracing is off are not passed in. */
export function collectTrace(
  events: readonly ({ type: string } & Record<string, unknown>)[],
): TurnTrace[] {
  const acc = emptyTrace();
  const out: TurnTrace[] = [];
  for (const e of events) {
    const closed = pushTrace(acc, e);
    if (closed) out.push(closed);
  }
  return out;
}
