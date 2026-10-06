import { describe, expect, it } from 'vitest';
import { readIntent } from '../../src/agent/intent.js';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import {
  existing,
  fileTask,
  fileWorker,
  firstText,
  planner,
  scenario,
} from '../support/scenarios.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { makeRepo, startTestRun } from '../support/harness.js';

const GATE = { name: 'test', run: 'node -e 0', timeout: '1m' };
const opts = {
  bootId: 'b',
  heartbeatMs: 50,
  controlPollMs: 20,
  pausePollMs: 10,
  notifier: { notify: () => Promise.resolve() },
};

/** Writes intent on the initial plan; in improvement round 1 adds M2; finds nothing in round 2. */
function beyondPlanner(): Script {
  const base = planner([{ id: 'M1', title: 'Ship v1', tasks: [fileTask('M1.T01')] }]);
  return (m) => {
    const text = firstText(m);
    if (m.turn === 0 && text.startsWith('There is no plan yet')) {
      return call('write_intent', {
        product: 'A tiny file-writing tool that proves the loop works end to end.',
        done: ['out/M1.T01.txt exists'],
        assumptions: ['no UI needed'],
        checks: ['test -f out/M1.T01.txt'],
      });
    }
    if (m.turn === 1 && text.startsWith('There is no plan yet')) return base({ ...m, turn: 0 });
    if (m.turn > 0) return say('Done.');
    if (text.includes('improvement round 1 of at most 3')) {
      return call('write_plan', {
        milestones: [
          ...existing(m).map((e) => ({
            id: e.id,
            title: e.title,
            tasks: e.tasks.map((t) => fileTask(t.id)),
          })),
          { id: 'M2', title: 'Harden', tasks: [fileTask('M2.T01'), fileTask('M2.T02')] },
        ],
      });
    }
    return base(m);
  };
}

describe('intent and beyond mode', () => {
  it('records intent, meets the goal, runs one improvement round, and stops when nothing is left', async () => {
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(beyondPlanner(), fileWorker)),
      config: { gates: [GATE], beyond: { enabled: true, max_rounds: 3 } },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, opts);
    expect(out.status).toBe('finished');
    expect(out.reason).toMatch(/goal plus 2 improvement rounds/);
    const intent = await readIntent(t.run.store);
    expect(intent).toContain('# Inferred intent');
    expect(intent).toContain('## Assumptions (steer to change)\n\n- no UI needed');
    const state = await t.run.store.readState();
    expect(state.acceptedCommits).toBe(3);
    expect(state.beyondRounds).toBe(2);
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'beyond.round').map((e) => e.added)).toEqual([3, 0]);
    expect(events.some((e) => e.type === 'intent.update')).toBe(true);
  });

  it('finishes straight away when beyond mode is off', async () => {
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(beyondPlanner(), fileWorker)),
      config: { gates: [GATE], beyond: { enabled: false } },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, opts);
    expect(out).toMatchObject({ status: 'finished' });
    expect(out.reason).not.toMatch(/improvement/);
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
  });
});
