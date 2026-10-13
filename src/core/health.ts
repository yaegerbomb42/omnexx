/**
 * How a live run is doing, for `runs` / `status` and the editor's Runs view: working, quiet,
 * waiting on providers, stalled (no heartbeat), or dead (no supervisor). Read-only.
 */
export type RunHealth = 'working' | 'quiet' | 'waiting' | 'stalled' | 'dead' | 'ended';

/** No event for this long while running reads as quiet (still within the stall watchdog). */
export const QUIET_AFTER_MS = 15 * 60_000;
const LIVE = new Set(['planned', 'running', 'paused']);
const WAITING_EVENTS = new Set(['provider.retry', 'provider.outage', 'provider.failover']);

export interface HealthInput {
  status: string;
  supervisorAlive: boolean;
  heartbeatStale: boolean;
  /** Type and time of the newest event, if any. */
  lastEvent?: { type: string; ts: number } | undefined;
  now: number;
}

export function runHealth(h: HealthInput): RunHealth {
  if (!LIVE.has(h.status)) return 'ended';
  if (!h.supervisorAlive) return 'dead';
  if (h.heartbeatStale) return 'stalled';
  if (h.lastEvent && WAITING_EVENTS.has(h.lastEvent.type)) return 'waiting';
  if (h.status === 'running' && (!h.lastEvent || h.now - h.lastEvent.ts >= QUIET_AFTER_MS))
    return 'quiet';
  return 'working';
}
