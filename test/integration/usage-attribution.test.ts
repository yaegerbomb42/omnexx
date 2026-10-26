import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { resolvePaths, usageFile } from '../../src/core/paths.js';
import {
  CALL_PURPOSES,
  readUsageLedger,
  summarizeUsage,
  type CallRecord,
} from '../../src/providers/usage-ledger.js';
import { startTestRun } from '../support/harness.js';
import { call, outage, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';

const onePlan = {
  milestones: [{ id: 'M1', title: 'Fix math', tasks: [{ id: 'M1.T01', title: 'Make add() add' }] }],
};

const fixAdd: Script = ({ turn }) =>
  [
    call('read', { path: 'src/math.js', note: 'add returns a - b' }),
    call('read', { path: 'src/math.js' }),
    call('str_replace', {
      path: 'src/math.js',
      old_str: 'return a - b;',
      new_str: 'return a + b;',
    }),
    say('Fixed add() to add; tests pass.'),
  ][turn] ?? say('done');

describe('usage attribution', () => {
  it('tags every billed call in the ledger, with no spend left untagged', async () => {
    const provider = new ScriptedProvider(fixAdd);
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider,
      plan: onePlan,
      config: { budget: { task_max_tokens: 10_000_000 } },
    });
    await runBaseline(t.run);
    await runOneCycle(t.run, 'M1.T01');
    const ledger = usageFile(resolvePaths(t.env));
    const calls = readUsageLedger(ledger).filter((r) => r.kind === 'call');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBe(t.run.state.spend.llmCalls);
    for (const c of calls) {
      expect(CALL_PURPOSES).toContain(c.purpose);
      expect(c.purpose).not.toBe('retry');
      expect(c.runId).toBe(t.run.state.runId);
      expect(c.taskId).toBe('M1.T01');
      expect(c.step).toMatch(/^c\d+\./);
      expect(c.inputTokens + c.outputTokens).toBeGreaterThan(0);
    }
    const report = summarizeUsage(readUsageLedger(ledger), t.run.state.runId);
    expect(report.attribution).toMatchObject({ untagged: 0, share: 1 });
    // The re-read guard ran inside the real loop and its savings reached the ledger.
    expect(report.waste.repeatRead.events).toBeGreaterThan(0);
    expect(report.waste.repeatRead.tokensSaved).toBeGreaterThan(0);
  });

  it('tags failed attempts as retry and coalesces the repeated error as waste', async () => {
    let failures = 0;
    const flaky: Script = (meta) => {
      if (failures < 2) {
        failures++;
        return outage();
      }
      return fixAdd(meta);
    };
    const provider = new ScriptedProvider(flaky);
    const t = await startTestRun({ fixture: 'ts-failing-test', provider, plan: onePlan });
    await runBaseline(t.run);
    await runOneCycle(t.run, 'M1.T01');
    const records = readUsageLedger(usageFile(resolvePaths(t.env)));
    const retries = records.filter(
      (r): r is CallRecord => r.kind === 'call' && r.purpose === 'retry',
    );
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(retries.every((r) => r.inputTokens === 0 && r.promptTokens && r.promptTokens > 0)).toBe(
      true,
    );
    const report = summarizeUsage(records, t.run.state.runId);
    expect(report.byPurpose.retry?.calls).toBe(retries.length);
    expect(report.waste.retries.events).toBeGreaterThan(0);
    expect(report.attribution.untagged).toBe(0);
  });

  it('parks a task at its cap, writes a checkpoint, and makes no call over it', async () => {
    const provider = new ScriptedProvider(fixAdd);
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider,
      plan: onePlan,
      config: { budget: { task_max_usd: 0.0000001 } },
    });
    await runBaseline(t.run);
    const callsBefore = provider.requests.length;
    await runOneCycle(t.run, 'M1.T01');
    expect(provider.requests.length).toBe(callsBefore);
    expect(t.run.state.taskCapHit).toMatchObject({
      taskId: 'M1.T01',
      kind: 'task_max_usd',
      cycle: 1,
    });
    const checkpoint = t.run.state.taskCapHit?.checkpoint;
    expect(checkpoint).toBeTruthy();
    const saved = JSON.parse(await readFile(checkpoint ?? '', 'utf8')) as {
      kind: string;
      taskId: string;
      cap: string;
    };
    expect(saved).toMatchObject({
      kind: 'task-park',
      taskId: 'M1.T01',
      cap: 'task_max_usd',
    });
  });
});
