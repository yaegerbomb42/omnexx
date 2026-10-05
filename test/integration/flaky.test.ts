import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { writeReport } from '../../src/core/report.js';
import { startTestRun } from '../support/harness.js';
import { call, say, ScriptedProvider } from '../support/scripted-provider.js';

const plan = {
  milestones: [
    {
      id: 'M1',
      title: 'Fix',
      tasks: [{ id: 'M1.T01', title: 'Make add() add', checks: ['node --test'] }],
    },
  ],
};

/**
 * Fails only on its 2nd run in this run's TMPDIR: the task check runs it first (pass), the gate
 * second (fail), the gate's re-run third (pass).
 */
const FLAKY_TEST = `import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('sometimes times out', () => {
  const file = join(tmpdir(), 'omnexx-flaky-count');
  const n = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
  writeFileSync(file, String(n));
  if (n === 2) throw new Error('flaked');
});
`;

const fix = call('str_replace', {
  path: 'src/math.js',
  old_str: 'return a - b;',
  new_str: 'return a + b;',
});

function worker(extra: ReturnType<typeof call>) {
  let n = 0;
  return new ScriptedProvider(() => {
    n++;
    if (n === 1) return fix;
    if (n === 2) return extra;
    return say('Fixed add().');
  });
}

describe('flaky tests', () => {
  it('a new failure that passes on re-run is accepted, recorded as a lesson and reported', async () => {
    const t = await startTestRun({
      provider: worker(call('write_file', { path: 'test/flaky.test.js', content: FLAKY_TEST })),
      plan,
    });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'accept' });
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'verify.flaky')).toMatchObject([
      { task: 'M1.T01', gate: 'test', ids: [expect.stringContaining('sometimes times out')] },
    ]);
    const notes = await t.run.store.readNotes();
    expect(notes.filter((n) => n.type === 'flaky')).toHaveLength(1);
    const report = await writeReport(t.run.store, t.run.state, t.run.plan, t.clock.now());
    expect(report).toMatch(/Flaky tests \(passed on re-run\): 1 \(/);
  });

  it('a real regression fails both runs and is still rejected', async () => {
    const t = await startTestRun({
      provider: worker(
        call('write_file', {
          path: 'test/broken.test.js',
          content: `import { test } from 'node:test';\ntest('always fails', () => { throw new Error('real'); });\n`,
        }),
      ),
      plan,
    });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'reject' });
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.some((e) => e.type === 'verify.flaky')).toBe(false);
    expect((await t.run.store.readNotes()).some((n) => n.type === 'flaky')).toBe(false);
  });

  it('flaky_reruns = 0 turns the re-run off', async () => {
    const t = await startTestRun({
      provider: worker(call('write_file', { path: 'test/flaky.test.js', content: FLAKY_TEST })),
      plan,
      config: {
        gates: [
          {
            name: 'test',
            run: 'node --test --test-reporter=tap',
            parser: 'node-test',
            flaky_reruns: 0,
          },
        ],
      },
    });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'reject' });
  });
});
