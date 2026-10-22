import { describe, expect, it } from 'vitest';
import { Run } from '../../../src/core/run.js';
import { startTestRun } from '../../support/harness.js';
import { say, ScriptedProvider } from '../../support/scripted-provider.js';

async function openRun(): Promise<Run> {
  const t = await startTestRun({
    provider: new ScriptedProvider(() => say('ok')),
  });
  return t.run;
}

describe('Run.signal', () => {
  it('returns a stable composite until newCycle()', async () => {
    const run = await openRun();
    const a = run.signal;
    const b = run.signal;
    expect(a).toBe(b);
    run.abortCycle('test hang');
    expect(run.signal.aborted).toBe(true);
    run.newCycle();
    expect(run.signal).not.toBe(a);
    expect(run.signal.aborted).toBe(false);
  });
});

describe('Run.save', () => {
  it('serializes overlapping writes so the latest in-memory state wins', async () => {
    const run = await openRun();
    for (let i = 0; i < 20; i++) {
      run.state.cycle = i * 2;
      const first = run.save();
      run.state.cycle = i * 2 + 1;
      const second = run.save();
      await Promise.all([first, second]);
      expect((await run.store.readState()).cycle).toBe(i * 2 + 1);
    }
  });
});
