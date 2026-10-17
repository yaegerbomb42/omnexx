import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { ConfigInput } from '../../src/config/schema.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import {
  asks,
  call,
  reviewAnswer,
  ScriptedProvider,
  say,
  type Script,
} from '../support/scripted-provider.js';

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
        if (!asks(req, 'reviewing a change')) return scripted.complete(req);
        reviews++;
        const findings =
          reviews === 1
            ? [{ severity: 'blocker', problem: 'name the edge case in a comment' }]
            : [];
        return Promise.resolve({
          content: reviewAnswer(req, { findings }, `r${reviews}`),
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
        // The per-cycle review and its amend are the plain pass's; a loop session reviews in place.
        plan: { mode: 'fast', loop: 'off' },
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

/** The harness's latest text to the model, when the last message is one (not tool results). */
function lastHarnessText(req: CompletionRequest): string | undefined {
  const last = req.messages.at(-1);
  if (last?.role !== 'user') return undefined;
  if (last.content.some((b) => b.type === 'tool_result')) return undefined;
  const texts = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
  return texts.length ? texts.join('\n') : undefined;
}

const FAILING_TEST =
  "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('extra', () => assert.equal(1, 2));\n";
const PASSING_TEST =
  "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('extra', () => assert.equal(2, 2));\n";

/**
 * A worker for the loop: writes an analysis when asked to think, breaks a test while executing,
 * fixes it when the harness sends the failure back, and addresses review findings.
 */
/** The conversation as the model saw it when asked to fix (requests are mutated after sending). */
const fixSeen: string[] = [];

const loopWorker: Script = (m) => {
  const said = lastHarnessText(m.request) ?? '';
  if (said.includes('checks fail') || said.includes('A review of your final diff'))
    fixSeen.push(JSON.stringify(m.request.messages));
  if (said.includes('# Think first'))
    return say('ANALYSIS: add out/M1.T01.txt and test/extra.test.js');
  if (said.includes('Now carry out your analysis'))
    return {
      tools: [
        { name: 'write_file', input: { path: 'out/M1.T01.txt', content: 'x\n' } },
        { name: 'write_file', input: { path: 'test/extra.test.js', content: FAILING_TEST } },
      ],
    };
  if (said.includes('checks fail on the current tree'))
    return call('write_file', { path: 'test/extra.test.js', content: PASSING_TEST });
  if (said.includes('A review of your final diff'))
    return call('write_file', { path: 'out/edge.txt', content: 'edge\n' });
  return say('done');
};

async function superviseLoop(provider: Provider, review = false) {
  const t = await startTestRun({
    repo: await makeRepo(),
    provider,
    config: {
      gates: [GATE],
      plan: { mode: 'fast' },
      review: { enabled: review, audit: review, strict_checks: false },
    },
  });
  const out = await supervise(t.run.deps, t.run.state.runId, {
    bootId: 'b',
    heartbeatMs: 50,
    controlPollMs: 20,
    pausePollMs: 10,
  });
  return { t, out, events: await readEvents(t.run.store.eventsPath) };
}

const plannerAsked = (p: ScriptedProvider): boolean =>
  p.requests.some((q) => q.system.some((b) => b.text.includes('You are the planner')));

describe('think-first loop (the default for the fast path)', () => {
  it('thinks first, keeps the analysis in the conversation, and fixes a failing gate forward', async () => {
    const provider = new ScriptedProvider(scenario(planner([]), loopWorker));
    const { t, out, events } = await superviseLoop(provider);
    expect(out.status).toBe('finished');
    const types = events.map((e) => e.type);
    // The think phase comes before any edit.
    expect(types.indexOf('loop.think')).toBeGreaterThan(-1);
    expect(types.indexOf('loop.think')).toBeLessThan(
      events.findIndex((e) => e.type === 'tool.call' && e.tool === 'write_file'),
    );
    expect(events.filter((e) => e.type === 'loop.check').map((e) => e.pass)).toEqual([false, true]);
    // Every check round records how long its gates took.
    const gates = events.filter((e) => e.type === 'loop.gates');
    expect(gates).toHaveLength(2);
    for (const g of gates) expect(g.ms).toBeGreaterThanOrEqual(0);
    // Fixed forward: no rollback, no fresh attempt, no planner.
    expect(types).not.toContain('rollback');
    expect(types).not.toContain('fast_path.fallback');
    expect(events.filter((e) => e.type === 'cycle.start')).toHaveLength(1);
    expect(plannerAsked(provider)).toBe(false);
    // The fix turn still sees the analysis it wrote, verbatim.
    const fix = fixSeen.find((x) => x.includes('checks fail on the current tree'));
    expect(fix).toContain('ANALYSIS: add out/M1.T01.txt');
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
  });

  it('turns the end review finding into one more turn in the same conversation, not a rollback', async () => {
    let reviews = 0;
    let audits = 0;
    const scripted = new ScriptedProvider(scenario(planner([]), loopWorker));
    const provider: Provider = {
      name: 'anthropic',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        const reviewing = asks(req, 'reviewing a change');
        const auditing = asks(req, 'You audit the result');
        if (!reviewing && !auditing) return scripted.complete(req);
        if (auditing) audits++;
        else reviews++;
        const findings =
          reviewing && reviews === 1
            ? [{ severity: 'blocker', problem: 'handle the edge case' }]
            : [];
        return Promise.resolve({
          content: reviewAnswer(req, { findings }, `r${reviews}`),
          stopReason: 'tool_use',
          usage: emptyUsage(),
          model: req.model,
        });
      },
    };
    const { t, out, events } = await superviseLoop(provider, true);
    expect(out.status).toBe('finished');
    expect(reviews).toBe(1);
    // The session's review of the whole diff replaces the separate pre-finish audit.
    expect(audits).toBe(0);
    expect(events.map((e) => e.type)).not.toContain('rollback');
    expect(events.filter((e) => e.type === 'loop.review')).toMatchObject([{ blocking: true }]);
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
    const fix = fixSeen.find((x) => x.includes('handle the edge case'));
    expect(fix).toContain('ANALYSIS: add out/M1.T01.txt');
  });

  it('never offers or starts a helper agent on the default path', async () => {
    const provider = new ScriptedProvider(scenario(planner([]), loopWorker));
    const { events } = await superviseLoop(provider);
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const q of provider.requests) expect(q.tools.map((x) => x.name)).not.toContain('task');
    expect(events.some((e) => e.type === 'subagent.start')).toBe(false);
  });

  it('leaves long goals to the planner and its milestones', async () => {
    const long = await runWith(
      fileWorker,
      { mode: 'auto', fast_max_goal_chars: 20 },
      'x'.repeat(40),
    );
    expect(long.planned).toBeGreaterThan(0);
    expect(long.events.some((e) => e.type === 'loop.think')).toBe(false);
    expect(long.events.some((e) => e.type === 'task.done')).toBe(true);
    // Planned tasks run sequentially, one agent each; the planner explores on its own.
    expect(long.events.some((e) => e.type === 'subagent.start')).toBe(false);
  });
});

describe('think-first loop: what the cycle would reject is caught inside the session', () => {
  it('sends an anti-cheat violation back as a failure, so the agent fixes it instead of losing the session', async () => {
    const worker: Script = (m) => {
      const said = lastHarnessText(m.request) ?? '';
      if (said.includes('# Think first')) return say('ANALYSIS: write the file');
      if (said.includes('Now carry out your analysis'))
        return {
          tools: [
            { name: 'write_file', input: { path: 'out/M1.T01.txt', content: 'x\n' } },
            {
              name: 'write_file',
              input: { path: 'scratch/probe.js', content: '// eslint-disable-next-line\nlet x;\n' },
            },
          ],
        };
      if (said.includes('anti-cheat')) return call('bash', { command: 'rm -r scratch' });
      return say('done');
    };
    const provider = new ScriptedProvider(scenario(planner([]), worker));
    const { t, out, events } = await superviseLoop(provider);
    expect(out.status).toBe('finished');
    const checks = events.filter((e) => e.type === 'loop.check');
    expect(checks.map((e) => e.pass)).toEqual([false, true]);
    expect(String(checks[0]?.failures)).toContain('anti-cheat');
    expect(events.map((e) => e.type)).not.toContain('rollback');
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
  });
});
