import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { fileTask, fileWorker, firstText, planner, scenario } from '../support/scenarios.js';
import { call, ScriptedProvider, type ScriptMeta } from '../support/scripted-provider.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};

describe('earned done: audit before finishing', () => {
  it('turns audit gaps into a milestone, and only finishes after a clean audit', async () => {
    const base = scenario(
      planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]),
      fileWorker,
    );
    const script = (m: ScriptMeta) =>
      firstText(m).includes('audit of the result against what the user asked for found these gaps')
        ? call('write_plan', {
            milestones: [
              { id: 'M2', title: 'Audit 1: close the gaps', tasks: [fileTask('M2.T01')] },
            ],
          })
        : base(m);
    const scripted = new ScriptedProvider(script);
    let audits = 0;
    const provider: Provider = {
      name: 'anthropic',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        if (!req.system.some((b) => b.text.includes('You audit the result')))
          return scripted.complete(req);
        audits++;
        const findings =
          audits === 1
            ? [
                {
                  severity: 'major',
                  problem: 'the README the goal asks for does not exist',
                  fix: 'write it',
                },
              ]
            : [];
        return Promise.resolve({
          content: [{ type: 'tool_use', id: `a${audits}`, name: 'answer', input: { findings } }],
          stopReason: 'tool_use',
          usage: emptyUsage(),
          model: req.model,
        });
      },
    };
    const t = await startTestRun({
      repo: await makeRepo(),
      provider,
      config: { gates: [GATE], review: { enabled: false, audit: true, strict_checks: false } },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
      pausePollMs: 10,
    });
    expect(out.status).toBe('finished');
    expect(audits).toBe(2);
    const plan = await t.run.store.readPlan();
    expect(plan?.nodes.find((n) => n.id === 'M2')).toMatchObject({
      title: 'Audit 1: close the gaps',
      status: 'done',
    });
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'audit.result').map((e) => e.gaps)).toEqual([1, 0]);
    expect((await t.run.store.readState()).acceptedCommits).toBe(2);
    // Each finished milestone leaves a walkthrough with its tasks, commits and evidence.
    const { readFile } = await import('node:fs/promises');
    const w1 = await readFile(t.run.store.file('walkthroughs/M1.md'), 'utf8');
    expect(w1).toMatch(/^# M1: Files/);
    expect(w1).toMatch(/\[x\] M1\.T01/);
    expect(w1).toMatch(/omnexx\(M1\.T01\)/);
    expect(w1).toMatch(/out\/M1\.T01\.txt/);
    const w2 = await readFile(t.run.store.file('walkthroughs/M2.md'), 'utf8');
    expect(w2).toMatch(/Audit 1: close the gaps/);
    expect(w2).not.toMatch(/M1\.T01/);
  });
});
