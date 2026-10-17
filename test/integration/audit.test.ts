import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { fileTask, fileWorker, firstText, planner, scenario } from '../support/scenarios.js';
import {
  asks,
  call,
  ScriptedProvider,
  type Script,
  type ScriptMeta,
} from '../support/scripted-provider.js';
import type { ConfigInput } from '../../src/config/schema.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};

const AUDIT_PLAN_PROMPT = 'audit of the result against what the user asked for found these gaps';

/** An auditor that always reports one major gap; counts how often it was asked. */
function gapAuditor(scripted: ScriptedProvider): Provider & { audits: () => number } {
  let audits = 0;
  return {
    name: 'anthropic',
    audits: () => audits,
    complete(req: CompletionRequest): Promise<CompletionResponse> {
      if (!asks(req, 'You audit the result')) return scripted.complete(req);
      audits++;
      const findings = [{ severity: 'major', problem: `gap ${audits}`, fix: 'close it' }];
      return Promise.resolve({
        content: [{ type: 'tool_use', id: `a${audits}`, name: 'answer', input: { findings } }],
        stopReason: 'tool_use',
        usage: emptyUsage(),
        model: req.model,
      });
    },
  };
}

/** Each audit planning round adds milestone M<round + 1> with `tasks` file tasks. */
function auditPlanner(base: Script, tasks: number): Script {
  let rounds = 0;
  return (m) => {
    if (m.turn > 0 || !firstText(m).includes(AUDIT_PLAN_PROMPT)) return base(m);
    rounds++;
    const id = `M${rounds + 1}`;
    return call('write_plan', {
      milestones: [
        {
          id,
          title: `Audit ${rounds}: close the gaps`,
          tasks: Array.from({ length: tasks }, (_, i) => fileTask(`${id}.T0${i + 1}`)),
        },
      ],
    });
  };
}

async function superviseRun(provider: Provider, config: ConfigInput) {
  const t = await startTestRun({ repo: await makeRepo(), provider, config });
  const out = await supervise(t.run.deps, t.run.state.runId, {
    bootId: 'b',
    heartbeatMs: 50,
    controlPollMs: 20,
    pausePollMs: 10,
  });
  return { t, out, events: await readEvents(t.run.store.eventsPath) };
}

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
        if (!asks(req, 'You audit the result')) return scripted.complete(req);
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

  it('skips audit work still open after audit_max_cycles and finishes on the last green', async () => {
    // Bench task-02/task-10: a goal met in cycle 1, then 20+ cycles on audit-added work.
    const base = scenario(
      planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]),
      fileWorker,
    );
    const provider = gapAuditor(new ScriptedProvider(auditPlanner(base, 5)));
    const { t, out, events } = await superviseRun(provider, {
      gates: [GATE],
      plan: { mode: 'full' },
      review: { enabled: false, audit: true, strict_checks: false, audit_max_cycles: 2 },
    });
    expect(out.status).toBe('finished');
    expect(provider.audits()).toBe(1);
    const plan = await t.run.store.readPlan();
    const node = (id: string) => plan?.nodes.find((n) => n.id === id);
    expect(node('M2.T01')?.status).toBe('done');
    expect(node('M2.T02')?.status).toBe('done');
    for (const id of ['M2', 'M2.T03', 'M2.T04', 'M2.T05'])
      expect(node(id)).toMatchObject({ status: 'parked', skipped: true });
    expect(events.filter((e) => e.type === 'audit.budget_spent')).toMatchObject([
      { cycles: 2, skipped: ['M2', 'M2.T03', 'M2.T04', 'M2.T05'] },
    ]);
  });

  it('gives a fast-path run a single audit round', async () => {
    const base = scenario(planner([]), fileWorker);
    const provider = gapAuditor(new ScriptedProvider(auditPlanner(base, 1)));
    const { t, out } = await superviseRun(provider, {
      gates: [GATE],
      plan: { mode: 'fast' },
      review: { enabled: false, audit: true, strict_checks: false, max_audits: 3 },
    });
    expect(out.status).toBe('finished');
    expect(provider.audits()).toBe(1);
    expect((await t.run.store.readPlan())?.nodes.find((n) => n.id === 'M2.T01')?.status).toBe(
      'done',
    );
  });

  it('skips padded milestones once an audit says the goal is met, and finishes', async () => {
    const scripted = new ScriptedProvider(
      scenario(
        planner([
          { id: 'M1', title: 'The goal', tasks: [fileTask('M1.T01')] },
          { id: 'M2', title: 'Hardening nobody asked for', tasks: [fileTask('M2.T01')] },
        ]),
        fileWorker,
      ),
    );
    let audits = 0;
    const provider: Provider = {
      name: 'anthropic',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        if (!asks(req, 'You audit the result')) return scripted.complete(req);
        audits++;
        return Promise.resolve({
          content: [
            { type: 'tool_use', id: `a${audits}`, name: 'answer', input: { findings: [] } },
          ],
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
    // One audit when M1 finished; nothing changed after it, so no second one at the end.
    expect(audits).toBe(1);
    const plan = await t.run.store.readPlan();
    expect(plan?.nodes.find((n) => n.id === 'M2')).toMatchObject({
      status: 'parked',
      skipped: true,
    });
    expect(plan?.nodes.find((n) => n.id === 'M2.T01')).toMatchObject({ skipped: true });
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'plan.skipped').map((e) => e.nodes)).toEqual([
      ['M2', 'M2.T01'],
    ]);
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
  });
});
