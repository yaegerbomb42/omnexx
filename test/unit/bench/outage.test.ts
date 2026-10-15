import { describe, expect, it } from 'vitest';
import { providerOutageMs } from '../../../bench/outage.ts';

describe('providerOutageMs', () => {
  it('counts from the stalled request to the recovery, and an unrecovered outage to the end', () => {
    const events = [
      { ts: 0, type: 'turn' },
      { ts: 100, type: 'tool.call' },
      { ts: 600, type: 'provider.failover' },
      { ts: 700, type: 'provider.retry' },
      { ts: 1_600, type: 'provider.recovered' },
      { ts: 1_700, type: 'turn' },
      { ts: 2_000, type: 'provider.failover' },
      { ts: 2_500, type: 'provider.retry' },
    ];
    expect(providerOutageMs(events)).toBe(1_500 + 800);
  });

  it('is zero for a run the provider never failed', () => {
    expect(providerOutageMs([{ ts: 0, type: 'turn' }])).toBe(0);
    expect(providerOutageMs([])).toBe(0);
  });
});
