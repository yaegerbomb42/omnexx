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
import { say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { FAST_SUPERVISE, makeRepo, PASSING_GATE, startTestRun } from '../support/harness.js';

const GATE = PASSING_GATE;
const opts = FAST_SUPERVISE;

/** Ships M1; improvement round 1 adds M2; every later round finds nothing. Records the prompts. */
function autoPlanner(prompts: string[]): Script {
  const base = planner([{ id: 'M1', title: 'Ship v1', tasks: [fileTask('M1.T01')] }]);
  return (m) => {
    const text = firstText(m);
    if (m.turn > 0) return say('Done.');
    if (!text.includes('improvement round')) return base(m);
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
});
