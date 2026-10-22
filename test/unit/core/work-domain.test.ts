import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import type { OmnexxConfig } from '../../../src/config/schema.js';
import type { WorkMode } from '../../../src/config/work-mode.js';
import type { OmnexxEvent } from '../../../src/core/events.js';
import { stateSchema } from '../../../src/core/run-store.js';
import { refreshRunConfig } from '../../../src/core/supervisor.js';

describe('run state workDomain', () => {
  it('an old state file without workDomain parses with the swe default', () => {
    const parsed = stateSchema.parse({
      version: 1,
      runId: 'r1',
      repoRoot: '/repo',
      repoName: 'repo',
      worktree: '/wt',
      branch: 'omnexx/r1',
      startRef: 'abc',
      lastGreen: 'abc',
      greenHistory: [{ sha: 'abc', cycle: 0 }],
      phase: 'init',
      status: 'running',
      cycle: 0,
      startedAt: 0,
      updatedAt: 0,
      activeMs: 0,
      goalHash: 'h',
      setupDone: false,
      spend: {
        usd: 0,
        tokens: { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
        turns: 0,
        llmCalls: 0,
        byModel: {},
        byProvider: {},
      },
      acceptedCommits: 0,
      beyondRounds: 0,
      idleRounds: 0,
      evidenceShown: [],
      auditRounds: 0,
      rejectedCycles: 0,
      lastProgressAt: 0,
      lastProgressCycle: 0,
      recoveries: 0,
      warned: [],
      recordedCycle: 0,
      checkpoints: [],
    });
    expect(parsed.workDomain).toBe('swe');
  });
});

interface FakeRun {
  config: OmnexxConfig;
  state: { executionMode: 'normal'; workDomain: WorkMode };
  save: () => Promise<void>;
  events: { emit: (type: string, data?: Record<string, unknown>) => OmnexxEvent };
}

function makeRun(domain: WorkMode = 'swe'): {
  run: FakeRun;
  emitted: { type: string; data: Record<string, unknown> }[];
} {
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const run: FakeRun = {
    config: defaultConfig({ execution: { domain } }),
    state: { executionMode: 'normal', workDomain: domain },
    save: () => Promise.resolve(),
    events: {
      emit: (type: string, data: Record<string, unknown> = {}) => {
        emitted.push({ type, data });
        return { ts: 0, runId: 'r', cycle: 0, type, ...data };
      },
    },
  };
  return { run, emitted };
}

describe('refreshRunConfig (hot work-domain switch)', () => {
  it('records the new domain and emits execution.domain_change', async () => {
    const { run, emitted } = makeRun('swe');
    const changed = await refreshRunConfig(run, () =>
      Promise.resolve(defaultConfig({ execution: { domain: 'general' } })),
    );
    expect(changed).toBe(true);
    expect(run.state.workDomain).toBe('general');
    expect(run.config.execution.domain).toBe('general');
    expect(emitted).toContainEqual({
      type: 'execution.domain_change',
      data: { from: 'swe', to: 'general' },
    });
    expect(emitted.map((e) => e.type)).not.toContain('execution.mode_change');
  });

  it('no domain change: no event, returns false', async () => {
    const { run, emitted } = makeRun('general');
    const changed = await refreshRunConfig(run, () =>
      Promise.resolve(defaultConfig({ execution: { domain: 'general' } })),
    );
    expect(changed).toBe(false);
    expect(emitted).toEqual([]);
  });
});
