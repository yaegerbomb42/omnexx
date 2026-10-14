import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
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

describe('in-cycle stuck signals', () => {
  it('a model re-reading the same file ends the cycle early as stuck, with evidence for the next try', async () => {
    const provider = new ScriptedProvider(() => call('read', { path: 'src/math.js' }));
    const t = await startTestRun({ provider, plan });
    await runBaseline(t.run);
    const verdict = await runOneCycle(t.run, 'M1.T01');
    expect(provider.requests).toHaveLength(3);
    expect(verdict).toMatchObject({ verdict: 'reject' });
    // The first cut-short attempt is a retry with the evidence, not a ladder climb.
    expect(verdict.stuck).not.toContain('repeated_tool_call');
    expect(verdict.evidence).toMatch(/cut short/);
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.find((e) => e.type === 'act.end')).toMatchObject({ end: 'stuck' });
    expect(events.filter((e) => e.type === 'stuck.signal')).toMatchObject([
      { signal: 'repeated_tool_call', task: 'M1.T01' },
    ]);
    // The same signal on the next attempt is a pattern: now the ladder climbs.
    const again = await runOneCycle(t.run, 'M1.T01');
    expect(again.stuck).toContain('repeated_tool_call');
  });

  it('editing the same file again counts as progress, not as turns without edits', async () => {
    // Bench task-10: a worker iterating on one test file was cut short as "no edits" because
    // only the number of distinct files was counted, and 600 lines of good work were rolled back.
    const provider = new ScriptedProvider(({ turn }) => {
      if (turn >= 6) return say('done');
      const [from, to] = turn % 2 ? ['b + a', 'a - b'] : ['a - b', 'b + a'];
      return call('str_replace', { path: 'src/math.js', old_str: from, new_str: to });
    });
    const t = await startTestRun({ provider, plan, config: { stuck: { no_edit_turns: 3 } } });
    await runBaseline(t.run);
    await runOneCycle(t.run, 'M1.T01');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.find((e) => e.type === 'stuck.in_cycle')).toBeUndefined();
    expect(events.find((e) => e.type === 'act.end')).toMatchObject({ end: 'done' });
  });

  it('partial work that passes the gates is still accepted when the cycle is cut short', async () => {
    let n = 0;
    const provider = new ScriptedProvider(() => {
      n++;
      if (n === 1)
        return call('str_replace', {
          path: 'src/math.js',
          old_str: 'return a - b;',
          new_str: 'return a + b;',
        });
      return call('read', { path: `src/math.js`, offset: n });
    });
    const t = await startTestRun({ provider, plan, config: { stuck: { no_edit_turns: 3 } } });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'accept', done: true });
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.find((e) => e.type === 'act.end')).toMatchObject({ end: 'stuck' });
    expect(events.find((e) => e.type === 'stuck.in_cycle')).toMatchObject({ signal: 'no_edits' });
    expect(t.run.state.cycleTokens).toHaveLength(1);
  });
});
