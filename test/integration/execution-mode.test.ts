import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { createRun } from '../../src/core/create.js';
import { readEvents } from '../../src/core/events.js';
import { resolvePaths } from '../../src/core/paths.js';
import { Run } from '../../src/core/run.js';
import { supervise } from '../../src/core/supervisor.js';
import { FakeClock } from '../support/clock.js';
import { FAST_SUPERVISE, NODE_TEST_GATE, makeRepo } from '../support/harness.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { isolatedEnv } from '../support/tmp.js';

/** Every knob the run needs, passed as flags so the project file only carries `[execution]`. */
const baseFlags: ConfigInput = {
  gates: [NODE_TEST_GATE],
  plan: { mode: 'full' },
  review: { enabled: false, audit: false, strict_checks: false },
  beyond: { enabled: false },
  skills: { import_claude: false },
  agents: { import_claude: false },
};

const projectToml = (mode: string) => `[execution]\nmode = "${mode}"\n`;

const planned = planner([
  {
    id: 'M1',
    title: 'Ship',
    tasks: [fileTask('M1.T01'), fileTask('M1.T02'), fileTask('M1.T03')],
  },
]);

async function startModeRun(mode: string, worker: Script) {
  const repo = await makeRepo({ 'omnexx.toml': projectToml(mode) });
  const env = await isolatedEnv();
  const clock = new FakeClock();
  const paths = resolvePaths(env);
  const goal = 'Make the test suite pass.';
  const { config } = await loadConfig({ cwd: repo, env, flags: baseFlags });
  const store = await createRun({
    paths,
    cwd: repo,
    goal,
    now: clock.now(),
    executionMode: config.execution.mode,
  });
  const run = await Run.open(
    {
      config,
      paths,
      env,
      clock,
      provider: new ScriptedProvider(scenario(planned, worker)),
      fetch: () => Promise.reject(new Error('network is not allowed in tests')),
    },
    store.runId,
  );
  return { store, repo, env, run };
}

const superviseOpts = (repo: string, env: NodeJS.ProcessEnv) => ({
  ...FAST_SUPERVISE,
  reloadConfig: async () => (await loadConfig({ cwd: repo, env, flags: baseFlags })).config,
});

describe('execution mode hot-switch at cycle boundaries', () => {
  it('applies a mode change from the next cycle, records it and emits execution.mode_change', async () => {
    let repoRef = '';
    let flipped = false;
    const worker: Script = (m) => {
      if (m.taskId === 'M1.T02' && m.turn === 0 && !flipped) {
        flipped = true;
        writeFileSync(join(repoRef, 'omnexx.toml'), projectToml('extreme'));
      }
      return fileWorker(m);
    };
    const { store, repo, env, run } = await startModeRun('normal', worker);
    repoRef = repo;

    const outcome = await supervise(run.deps, run.state.runId, superviseOpts(repo, env));

    expect(outcome.status).toBe('finished');
    expect(flipped).toBe(true);
    const state = await store.readState();
    expect(state.executionMode).toBe('extreme');
    const events = await readEvents(store.eventsPath);
    const changes = events.filter((e) => e.type === 'execution.mode_change');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'normal', to: 'extreme' });
    expect(events.some((e) => e.type === 'config.reload_failed')).toBe(false);
  });

  it('no change: no event, the recorded mode stays', async () => {
    const { store, repo, env, run } = await startModeRun('normal', fileWorker);

    const outcome = await supervise(run.deps, run.state.runId, superviseOpts(repo, env));

    expect(outcome.status).toBe('finished');
    const state = await store.readState();
    expect(state.executionMode).toBe('normal');
    const events = await readEvents(store.eventsPath);
    expect(events.filter((e) => e.type === 'execution.mode_change')).toHaveLength(0);
  });

  it('a broken project file mid-run does not end the run: config.reload_failed, mode unchanged', async () => {
    let repoRef = '';
    let flipped = false;
    const worker: Script = (m) => {
      if (m.taskId === 'M1.T02' && m.turn === 0 && !flipped) {
        flipped = true;
        writeFileSync(join(repoRef, 'omnexx.toml'), '[execution\nmode = "extreme"\n');
      }
      return fileWorker(m);
    };
    const { store, repo, env, run } = await startModeRun('normal', worker);
    repoRef = repo;

    const outcome = await supervise(run.deps, run.state.runId, superviseOpts(repo, env));

    expect(outcome.status).toBe('finished');
    expect(flipped).toBe(true);
    const state = await store.readState();
    expect(state.executionMode).toBe('normal');
    const events = await readEvents(store.eventsPath);
    expect(events.filter((e) => e.type === 'execution.mode_change')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'config.reload_failed').length).toBeGreaterThan(0);
  });
});
