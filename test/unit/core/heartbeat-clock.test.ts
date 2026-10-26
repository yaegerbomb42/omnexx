import { describe, expect, it } from 'vitest';
import { startHeartbeat } from '../../../src/core/heartbeat.js';
import type { Run } from '../../../src/core/run.js';
import type { Heartbeat } from '../../../src/core/run-store.js';
import { FakeClock } from '../../support/clock.js';

describe('startHeartbeat clock', () => {
  it('stamps heartbeat ts from the run clock, not the wall clock', () => {
    const clock = new FakeClock(1_577_836_800_000);
    const beats: Heartbeat[] = [];
    const run = {
      paused: false,
      clock,
      state: {
        status: 'running',
        phase: 'init',
        cycle: 0,
        taskId: undefined,
        spend: { usd: 0 },
        lastGreen: 's',
      },
      store: {
        writeHeartbeat: (hb: Heartbeat): Promise<void> => {
          beats.push(hb);
          return Promise.resolve();
        },
      },
    } as unknown as Run;
    const stop = startHeartbeat(run, 60_000);
    stop();
    expect(beats).toHaveLength(1);
    expect(beats[0]?.ts).toBe(clock.now());
  });
});
