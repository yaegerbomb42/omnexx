import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import type { OmnexxConfig } from '../../../src/config/schema.js';
import { refreshRunConfig } from '../../../src/core/supervisor.js';
import type { OmnexxEvent } from '../../../src/core/events.js';

type FakeRun = {
  config: OmnexxConfig;
  state: { executionMode: 'efficient' | 'normal' | 'extreme' };
  save: () => Promise<void>;
  events: { emit: (type: string, data?: Record<string, unknown>) => OmnexxEvent };
};

function makeRun(mode: 'efficient' | 'normal' | 'extreme' = 'normal'): {
  run: FakeRun;
  emitted: { type: string; data: Record<string, unknown> }[];
} {
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const run: FakeRun = {
    config: defaultConfig({ execution: { mode }, plan: { mode: 'full' } }),
    state: { executionMode: mode },
    save: async () => {},
    events: {
      emit: (type: string, data: Record<string, unknown> = {}) => {
        emitted.push({ type, data });
        return { ts: 0, runId: 'r', cycle: 0, type, ...data };
      },
    },
  };
  return { run, emitted };
}

/** A config whose plan/loop values are exactly what the `efficient` preset contributes. */
const efficientConfig = () =>
  defaultConfig({
    execution: { mode: 'efficient' },
    plan: {
      mode: 'fast',
      fast_attempts: 1,
      loop_rounds: 4,
      loop_rethinks: 1,
      loop_rewinds: 1,
      loop_flaky_reruns: 1,
      loop_think_turns: 4,
    },
  });

describe('refreshRunConfig (hot execution-mode switch)', () => {
  it('applies the new preset in place, records the mode and emits execution.mode_change', async () => {
    const { run, emitted } = makeRun('normal');
    const changed = await refreshRunConfig(run, async () => efficientConfig());

    expect(changed).toBe(true);
    expect(run.state.executionMode).toBe('efficient');
    // The preset is applied: plan/loop keys now match the efficient preset.
    expect(run.config.execution.mode).toBe('efficient');
    expect(run.config.plan.mode).toBe('fast');
    expect(run.config.plan.loop_rounds).toBe(4);
    expect(run.config.plan.loop_think_turns).toBe(4);
    expect(run.config.plan.loop_rethinks).toBe(1);
    expect(emitted).toContainEqual({
      type: 'execution.mode_change',
      data: { from: 'normal', to: 'efficient' },
    });
  });

  it('switching back to normal drops the preset and records it', async () => {
    const { run, emitted } = makeRun('extreme');
    const changed = await refreshRunConfig(run, async () =>
      defaultConfig({ execution: { mode: 'normal' } }),
    );

    expect(changed).toBe(true);
    expect(run.state.executionMode).toBe('normal');
    // No preset: plan/loop return to the plain defaults.
    expect(run.config.execution.mode).toBe('normal');
    expect(run.config.plan.mode).toBe('auto');
    expect(run.config.plan.loop_rounds).toBe(6);
    expect(emitted).toContainEqual({
      type: 'execution.mode_change',
      data: { from: 'extreme', to: 'normal' },
    });
  });

  it('no mode change: no event, state untouched', async () => {
    const { run, emitted } = makeRun('normal');
    const changed = await refreshRunConfig(run, async () =>
      defaultConfig({ execution: { mode: 'normal' } }),
    );

    expect(changed).toBe(false);
    expect(run.state.executionMode).toBe('normal');
    expect(emitted).toEqual([]);
  });

  it('a failed reload keeps the previous config and emits config.reload_failed', async () => {
    const { run, emitted } = makeRun('extreme');
    const before = run.config.plan.loop_rounds;
    const changed = await refreshRunConfig(run, async () => {
      throw new Error('omnexx.toml:3:4: invalid TOML');
    });

    expect(changed).toBe(false);
    expect(run.state.executionMode).toBe('extreme');
    expect(run.config.plan.loop_rounds).toBe(before);
    expect(emitted).toContainEqual({
      type: 'config.reload_failed',
      data: { error: 'omnexx.toml:3:4: invalid TOML' },
    });
  });
});
