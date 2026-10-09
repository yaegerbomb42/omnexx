import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import { fileTask, planner, scenario } from '../support/scenarios.js';
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

/** Writes a two-item list, does the work, stops with one item open, then closes it when nudged. */
const forgetfulWorker: Script = (m) => {
  const file = `out/${m.taskId ?? ''}.txt`;
  const items = (second: string) => ({
    items: [
      { text: 'write the file', status: 'done' },
      { text: 'check it', status: second },
    ],
  });
  if (m.turn === 0) return call('todo', items('pending'));
  if (m.turn === 1) return call('write_file', { path: file, content: 'x\n' });
  if (m.turn === 2) return say('Done.');
  if (m.turn === 3) return call('todo', items('done'));
  return say('Checked; all done.');
};

describe('todo completion', () => {
  it('reminds a worker once when it stops with open items, and the list ends fully checked', async () => {
    // Arrange
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(
        scenario(
          planner([{ id: 'M1', title: 'One', tasks: [fileTask('M1.T01')] }]),
          forgetfulWorker,
        ),
      ),
      config: { gates: [GATE], beyond: { enabled: false } },
    });

    // Act
    const out = await supervise(t.run.deps, t.run.state.runId, opts);

    // Assert
    expect(out.status).toBe('finished');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'todo.nudge')).toEqual([
      expect.objectContaining({ open: 1 }),
    ]);
    const last = events.filter((e) => e.type === 'todo.update').at(-1);
    expect(last?.items).toEqual([
      { text: 'write the file', status: 'done' },
      { text: 'check it', status: 'done' },
    ]);
  });
});
