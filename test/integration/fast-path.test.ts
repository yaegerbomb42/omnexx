import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { ConfigInput } from '../../src/config/schema.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { call, ScriptedProvider, say, type Script } from '../support/scripted-provider.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};

async function runWith(worker: Script, plan: ConfigInput['plan'], goal?: string) {
  const provider = new ScriptedProvider(
    scenario(planner([{ id: 'M1', title: 'Planned', tasks: [fileTask('M1.T05')] }]), worker),
  );
  const t = await startTestRun({
    repo: await makeRepo(),
    provider,
    config: { gates: [GATE], plan },
    ...(goal ? { goal } : {}),
  });
  const out = await supervise(t.run.deps, t.run.state.runId, {
    bootId: 'b',
    heartbeatMs: 50,
    controlPollMs: 20,
    pausePollMs: 10,
  });
  const events = await readEvents(t.run.store.eventsPath);
  const planned = provider.requests.filter((q) =>
    q.system.some((b) => b.text.includes('You are the planner')),
  ).length;
  return { t, out, events, planned };
}

describe('fast path: one pass on the whole goal before planning', () => {
  it('finishes a small goal in one cycle without ever calling the planner', async () => {
    const { t, out, events, planned } = await runWith(fileWorker, { mode: 'auto' });
    expect(out.status).toBe('finished');
    expect(planned).toBe(0);
    expect(events.filter((e) => e.type === 'plan.written').map((e) => e.mode)).toEqual(['fast']);
    const plan = await t.run.store.readPlan();
    expect(plan?.nodes.find((n) => n.id === 'M1.T01')).toMatchObject({
      status: 'done',
      checks: ['node --test --test-reporter=tap'],
    });
    expect((await t.run.store.readState()).fastPath).toBe('tried');
  });

  it('hands over to the planner after fast_attempts cycles without finishing', async () => {
    // The one pass changes nothing; the planned task then goes through.
    const worker: Script = (m) => (m.taskId === 'M1.T01' ? say('could not do it') : fileWorker(m));
    const { t, out, events, planned } = await runWith(worker, { mode: 'fast', fast_attempts: 2 });
    expect(out.status).toBe('finished');
    expect(planned).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'fast_path.fallback')).toMatchObject([{ attempts: 2 }]);
    expect(events.filter((e) => e.type === 'plan.written').map((e) => e.mode)).toEqual([
      'fast',
      'initial',
    ]);
    const plan = await t.run.store.readPlan();
    expect(plan?.nodes.map((n) => n.id)).toEqual(['M1', 'M1.T05']);
    expect((await t.run.store.readState()).fastPath).toBe('failed');
  });

  it('auto mode plans first for long goals, and full mode always plans', async () => {
    const long = await runWith(
      fileWorker,
      { mode: 'auto', fast_max_goal_chars: 20 },
      'x'.repeat(40),
    );
    expect(long.planned).toBeGreaterThan(0);
    expect(long.events.some((e) => e.type === 'plan.written' && e.mode === 'fast')).toBe(false);
    const full = await runWith(fileWorker, { mode: 'full' });
    expect(full.planned).toBeGreaterThan(0);
  });

  it('holds the first plan to the milestone count and helpers the user set', async () => {
    const two = {
      milestones: [
        { id: 'M1', title: 'One', tasks: [fileTask('M1.T01')] },
        { id: 'M2', title: 'Two', tasks: [fileTask('M2.T01')] },
      ],
    };
    const one = { milestones: [{ id: 'M1', title: 'One', tasks: [fileTask('M1.T01')] }] };
    const results: string[] = [];
    const provider = new ScriptedProvider((m) => {
      if (!m.planner) return scenario(() => say(''), fileWorker)(m);
      const last = m.request.messages.at(-1)?.content.find((b) => b.type === 'tool_result');
      if (last?.type === 'tool_result') results.push(JSON.stringify(last.content));
      return call('write_plan', m.turn === 0 ? two : one);
    });
    const t = await startTestRun({
      repo: await makeRepo(),
      provider,
      config: { gates: [GATE], plan: { mode: 'full', milestones: 1, helpers: 0 } },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
      pausePollMs: 10,
    });
    expect(out.status).toBe('finished');
    expect(results[0]).toMatch(/2 milestones, but this run allows at most 1/);
    const first = provider.requests.find((q) =>
      q.system.some((b) => b.text.includes('You are the planner')),
    );
    expect(JSON.stringify(first?.messages)).toContain('Use at most one milestone.');
    expect(JSON.stringify(first?.messages)).toContain('helpers are off for this run');
    expect(first?.tools.some((x) => x.name === 'task')).toBe(false);
  });

  it('keeps work the reviewer only asked to amend: the next attempt starts from it', async () => {
    let reviews = 0;
    const scripted = new ScriptedProvider(
      scenario(
        planner([]),
        // First attempt writes the file; the amend attempt changes nothing more.
        (m) => (m.attempt === 1 ? fileWorker(m) : say('amended')),
      ),
    );
    const provider: Provider = {
      name: 'anthropic',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        if (!req.system.some((b) => b.text.includes('reviewing a change')))
          return scripted.complete(req);
        reviews++;
        const findings =
          reviews === 1
            ? [{ severity: 'blocker', problem: 'name the edge case in a comment' }]
            : [];
        return Promise.resolve({
          content: [{ type: 'tool_use', id: `r${reviews}`, name: 'answer', input: { findings } }],
          stopReason: 'tool_use',
          usage: emptyUsage(),
          model: req.model,
        });
      },
    };
    const t = await startTestRun({
      repo: await makeRepo(),
      provider,
      config: {
        gates: [GATE],
        plan: { mode: 'fast' },
        review: { enabled: true, audit: false, strict_checks: false },
      },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
      pausePollMs: 10,
    });
    expect(out.status).toBe('finished');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'amend.applied')).toMatchObject([{ ok: true }]);
    expect(events.some((e) => e.type === 'fast_path.fallback')).toBe(false);
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
    expect(reviews).toBe(2);
  });
});
