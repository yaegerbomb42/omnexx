import { describe, expect, it } from 'vitest';
import { emptyTelemetry, fold } from '../../../src/telemetry/aggregate.js';
import { health, runCardRows } from '../../../src/tui/run-card.js';

const ev = (type: string, ts: number, data: Record<string, unknown> = {}) =>
  ({ type, ts, cycle: 1, runId: 'r', ...data }) as never;

describe('run card', () => {
  it('shows progress, model choice, switches and models out of quota', () => {
    const t = emptyTelemetry();
    fold(t, ev('run.start', 0));
    fold(t, ev('route.decision', 1_000, { by: 'judge', model: 'pool:kimi' }));
    fold(t, ev('provider.failover', 2_000, { provider: 'pool', model: 'glm-5.3' }));
    fold(t, ev('provider.quota_exhausted', 2_000, { model: 'pool:glm-5.3' }));
    fold(t, ev('milestone.done', 3_000));
    t.model = 'pool:deepseek-v4-pro';
    const rows = runCardRows({
      runId: 'r',
      alive: true,
      phase: 'cycling',
      done: 3,
      tasks: 9,
      t,
      now: 3_000,
    });
    expect(rows[0]).toMatch(/cycling · cycle 1 · .* · healthy/);
    expect(rows[1]).toMatch(/3\/9 tasks · 1 milestone/);
    expect(rows[2]).toBe('model deepseek-v4-pro (Nimble pick) · 1 switch · out of quota: glm-5.3');
  });

  it('flags a run that has gone silent or stopped', () => {
    expect(health(true, 0, 20 * 60_000)).toMatch(/^silent/);
    expect(health(true, 0, 2 * 60_000)).toMatch(/^quiet/);
    expect(health(false, 0, 1)).toBe('stopped');
  });
});
