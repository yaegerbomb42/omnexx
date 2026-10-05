import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { startTestRun } from '../support/harness.js';
import { call, ScriptedProvider } from '../support/scripted-provider.js';

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
    expect(verdict.stuck).toContain('repeated_tool_call');
    expect(verdict.evidence).toMatch(/cut short/);
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.find((e) => e.type === 'act.end')).toMatchObject({ end: 'stuck' });
    expect(events.filter((e) => e.type === 'stuck.signal')).toMatchObject([
      { signal: 'repeated_tool_call', task: 'M1.T01' },
    ]);
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
