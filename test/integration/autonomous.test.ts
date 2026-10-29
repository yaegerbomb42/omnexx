import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import {
  addMilestone,
  fileTask,
  fileWorker,
  firstText,
  planner,
  scenario,
} from '../support/scenarios.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { FAST_SUPERVISE, makeRepo, PASSING_GATE, startTestRun } from '../support/harness.js';

const GATE = PASSING_GATE;
/** Fails whenever out/bad.txt exists, so a cycle that writes it is rejected and rolled back. */
const REJECTS_BAD = {
  name: 'test',
  run: "node -e \"process.exit(require('fs').existsSync('out/bad.txt') ? 1 : 0)\"",
  timeout: '1m',
};

/** Writes a different bad file each cycle, so no repeated-signature guard catches it first. */
const badFileWorker: Script = (m) =>
  m.turn === 0
    ? call('write_file', {
        path: 'out/bad.txt',
        content: `${m.taskId ?? ''} ${String(Math.random())}\n`,
      })
    : say('Wrote out/bad.txt.');
const opts = FAST_SUPERVISE;

/** Ships M1; improvement round 1 adds M2; every later round finds nothing. Records the prompts. */
function autoPlanner(prompts: string[]): Script {
  const base = planner([{ id: 'M1', title: 'Ship v1', tasks: [fileTask('M1.T01')] }]);
  return (m) => {
    const text = firstText(m);
    if (m.turn > 0) return say('Done.');
    // The round prompt names its number; the first plan's prompt only mentions rounds in passing.
    if (!/improvement round \d+\./.test(text)) return base(m);
    prompts.push(text);
    if (text.includes('improvement round 1.')) {
      return addMilestone(m, { id: 'M2', title: 'Harden', tasks: [fileTask('M2.T01')] });
    }
    return base(m);
  };
}

describe('autonomous mode', () => {
  it('keeps planning rounds past the beyond cap, each on the next focus area, until max_idle_rounds', async () => {
    // Arrange
    const prompts: string[] = [];
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(autoPlanner(prompts), fileWorker)),
      config: {
        gates: [GATE],
        beyond: { enabled: false, max_rounds: 1 },
        autonomous: { enabled: true, max_idle_rounds: 3, focus: ['port the docs to markdown'] },
      },
    });

    // Act
    const out = await supervise(t.run.deps, t.run.state.runId, opts);

    // Assert
    expect(out.status).toBe('finished');
    const state = await t.run.store.readState();
    expect(state.acceptedCommits).toBe(2);
    expect(state.beyondRounds).toBe(4);
    expect(state.idleRounds).toBe(3);
    expect(prompts[0]).toContain('This round focuses on: port the docs to markdown');
    expect(prompts[1]).toContain('This round focuses on: correctness hardening');
    expect(prompts[0]).not.toContain('of at most');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'autonomous.idle').map((e) => e.idle)).toEqual([
      1, 2, 3,
    ]);
  });

  it('parks work that makes no progress and moves on, instead of stopping to ask', async () => {
    // Arrange: M1.T01 keeps writing a file the gate rejects, so every cycle on it rolls back;
    // M1.T02 can pass.
    const stuckWorker: Script = (m) => (m.taskId === 'M1.T01' ? badFileWorker(m) : fileWorker(m));
    const plan = planner([
      { id: 'M1', title: 'Ship', tasks: [fileTask('M1.T01'), fileTask('M1.T02')] },
    ]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, stuckWorker)),
      config: {
        gates: [REJECTS_BAD],
        beyond: { enabled: false, max_rounds: 1 },
        autonomous: { enabled: true, max_idle_rounds: 1 },
        // Only the no-progress watchdog can catch it: the ladder thresholds are out of reach.
        stuck: {
          no_progress_cycles: 3,
          max_consecutive_rejections: 50,
          max_same_signature: 50,
          max_task_cycles: 50,
        },
      },
    });

    // Act
    const out = await supervise(t.run.deps, t.run.state.runId, opts);

    // Assert
    expect(out.status).toBe('finished');
    const plan2 = await t.run.store.readPlan();
    const t1 = plan2?.nodes.find((n) => n.id === 'M1.T01');
    expect(t1?.status).toBe('parked');
    expect(t1?.parkedReason).toMatch(/no progress/);
    expect(plan2?.nodes.find((n) => n.id === 'M1.T02')?.status).toBe('done');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'autonomous.recover')).toHaveLength(1);
  });

  it('still stops after max_idle_rounds recoveries in a row with nothing accepted', async () => {
    // Arrange: every task writes the file the gate rejects.
    const never: Script = badFileWorker;
    const plan = planner([
      {
        id: 'M1',
        title: 'Ship',
        tasks: [fileTask('M1.T01'), fileTask('M1.T02'), fileTask('M1.T03')],
      },
    ]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, never)),
      config: {
        gates: [REJECTS_BAD],
        beyond: { enabled: false, max_rounds: 1 },
        autonomous: { enabled: true, max_idle_rounds: 2 },
        stuck: {
          no_progress_cycles: 2,
          max_consecutive_rejections: 50,
          max_same_signature: 50,
          max_task_cycles: 50,
        },
      },
    });

    // Act
    const out = await supervise(t.run.deps, t.run.state.runId, opts);

    // Assert
    expect(out.status).toBe('blocked');
    expect(out.reason).toMatch(/no accepted commit/);
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'autonomous.recover')).toHaveLength(2);
  });
});
