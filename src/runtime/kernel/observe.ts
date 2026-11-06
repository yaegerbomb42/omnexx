/**
 * Observe-only kernel snapshot: what the VS Code Kernel card and `omnexx kernel` show.
 * Built from the loop's `kernel.allocate` event payload (no extra kernel calls).
 */
export interface KernelObserveSnapshot {
  turn: number;
  phase: string;
  taskClass: string;
  tier: number;
  cadence: string;
  reason: string;
  epoch: number;
  rank: string;
  /** Mounted capability id -> why chosen. */
  active: { id: string; why: string }[];
  mountSavings: { catalogTokens: number; mountedTokens: number } | null;
  priors: { arm: string; pulls: number; mean: number }[];
}

const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : d);
const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

export function snapshotFromAllocateEvent(e: Record<string, unknown>): KernelObserveSnapshot {
  const why =
    e.why && typeof e.why === 'object'
      ? (e.why as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const ms = e.mountSavings as { catalogTokens?: unknown; mountedTokens?: unknown } | undefined;
  return {
    turn: num(e.turn),
    phase: str(e.phase, 'orient'),
    taskClass: str(e.taskClass, 'standard'),
    tier: num(e.tier),
    cadence: str(e.cadence, 'stay_sticky'),
    reason: str(e.reason, 'sticky_progress'),
    epoch: num(e.epoch, 1),
    rank: str(e.rank, 'bm25'),
    active: Object.entries(why)
      .slice(0, 8)
      .map(([id, w]) => ({ id, why: str(w) })),
    mountSavings: ms
      ? { catalogTokens: num(ms.catalogTokens), mountedTokens: num(ms.mountedTokens) }
      : null,
    priors: Array.isArray(e.priors)
      ? (e.priors as { arm: string; pulls: number; mean: number }[]).slice(0, 5)
      : [],
  };
}

/** "sticky · prefix cached" style one-liner for the cadence decision. */
export function cadenceLabel(
  s: Pick<KernelObserveSnapshot, 'cadence' | 'reason' | 'epoch'>,
): string {
  const what: Record<string, string> = {
    stay_sticky: 'sticky · prefix cached',
    reselect_append_only: 'reselected · append-only (prefix cached)',
    rebake_epoch: `re-baked tools · epoch ${String(s.epoch)}`,
    compact_gc: 'compacted context',
    escalate_mode: 'escalated reasoning',
    verify_now: 'verify now',
  };
  return `${what[s.cadence] ?? s.cadence} (${s.reason.replace(/_/g, ' ')})`;
}
