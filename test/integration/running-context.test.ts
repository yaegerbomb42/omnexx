import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { RunningContext } from '../../src/core/running-context.js';
import { startTestRun } from '../support/harness.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';

const plan = {
  milestones: [
    { id: 'M1', title: 'Fix', tasks: [{ id: 'M1.T01', title: 'Make add() add', checks: [] }] },
  ],
};

describe('running context', () => {
  it('keeps the newest entries when it grows past what a prompt should carry', async () => {
    const t = await startTestRun({ provider: new ScriptedProvider(() => say('x')), plan });
    const rc = new RunningContext(t.run.store, 'M1.T01');
    for (let i = 0; i < 60; i++) await rc.add('progress', `step ${i} `.repeat(40));
    const shown = await rc.forPrompt();
    expect(shown).toMatch(/older entries omitted/);
    expect(shown).toContain('step 59');
    expect(shown).not.toContain('step 0 ');
    expect(shown.length).toBeLessThan(13_000);
  });

  it('what the agent and the harness wrote is the next cycle’s starting point, then archived when done', async () => {
    // Attempt 1: note a dead end, change nothing (rejected). Attempt 2: fix it (accepted, done).
    const script: Script = ({ attempt, turn }) =>
      attempt === 1
        ? ([
            call('running_context', {
              kind: 'dead_end',
              text: 'editing test/math.test.js is pointless: the bug is in src/math.js',
            }),
          ][turn] ?? say('stuck'))
        : ([
            call('str_replace', {
              path: 'src/math.js',
              old_str: 'return a - b;',
              new_str: 'return a + b;',
            }),
          ][turn] ?? say('Fixed add().'));
    const provider = new ScriptedProvider(script);
    const t = await startTestRun({ provider, plan });
    await runBaseline(t.run);
    expect((await runOneCycle(t.run, 'M1.T01')).verdict).toBe('reject');
    const second = provider.requests.length;
    expect((await runOneCycle(t.run, 'M1.T01')).verdict).toBe('accept');
    const first = provider.requests[second]?.messages[0]?.content[0];
    const text = first?.type === 'text' ? first.text : '';
    expect(text).toMatch(/# Your running context for M1\.T01/);
    expect(text).toMatch(/### dead_end[\s\S]*the bug is in src\/math\.js/);
    expect(text).toMatch(/### checkpoint · cycle 1[\s\S]*Rejected: no changes/);
    // Done: the live file is gone, the archive has the whole story.
    const rc = new RunningContext(t.run.store, 'M1.T01');
    expect(await rc.read()).toBe('');
    const [archived] = await RunningContext.archived(t.run.store, ['M1.T01']);
    expect(archived?.text).toMatch(/Accepted: the task is done/);
    expect(existsSync(t.run.store.file('running-context/M1.T01.md'))).toBe(false);
  });
});
