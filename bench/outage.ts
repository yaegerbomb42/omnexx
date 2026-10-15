/**
 * Time a run spent waiting on its provider, from the run's events. An outage window opens when
 * the request that failed was sent (the event before the first `provider.failover`, since a
 * stalled request sits silent until it fails) and closes at `provider.recovered`, or at the last
 * event when it never did. Concurrent bench runs share one upstream, so a stall there shows up as
 * the same window in every run; this separates it from the agent's own time.
 */
export interface OutageEvent {
  ts: number;
  type: string;
}

export function providerOutageMs(events: readonly OutageEvent[]): number {
  let total = 0;
  let openedAt: number | undefined;
  for (const [i, e] of events.entries()) {
    if (e.type === 'provider.failover' && openedAt === undefined)
      openedAt = events[i - 1]?.ts ?? e.ts;
    else if (e.type === 'provider.recovered' && openedAt !== undefined) {
      total += e.ts - openedAt;
      openedAt = undefined;
    }
  }
  const last = events.at(-1);
  if (openedAt !== undefined && last) total += last.ts - openedAt;
  return total;
}
