import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { git } from '../../src/git/git.js';
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
const GOAL = [
  'Build the inventory:',
  '1. add products',
  '2. receive stock',
  '3. ship stock',
  '4. reserve stock',
  '5. fulfil a reservation even when nothing else is available',
].join('\n');
/** The spec test needs out/M2.T01.txt: only the fix task (M2.T01) makes it pass. */
const SPEC_FILE = 'omnexx-spec/fulfil.test.mjs';
const SUITE = {
  command: 'node --test omnexx-spec/fulfil.test.mjs',
  files: [
    {
      path: SPEC_FILE,
      content: [
        "import { test } from 'node:test';",
        "import { existsSync } from 'node:fs';",
        "test('fulfil ships reserved stock', () => {",
        "  if (!existsSync('out/M2.T01.txt')) throw new Error('fulfil re-checked available stock');",
        '});',
        // A passing case too: a suite failing most of its tests on green code is judged wrong.
        "test('reserve lowers available', () => {});",
      ].join('\n'),
    },
  ],
};
const WRITER = 'You write independent acceptance tests';
const JUDGE = 'You settle a dispute about acceptance tests';

interface Calls {
  writer: number;
  judge: number;
  workerPrompts: string[];
}

/** Scripted planner/worker plus a spec-test writer and judge answering through the answer tool. */
function provider(worker: Script, judgeDrop: (n: number) => string[]): Provider & Calls {
  const scripted = new ScriptedProvider(
    scenario(planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]), worker),
  );
  const answer = (req: CompletionRequest, input: unknown): Promise<CompletionResponse> =>
    Promise.resolve({
      content: [{ type: 'tool_use', id: 'x', name: 'answer', input }],
      stopReason: 'tool_use',
      usage: emptyUsage(),
      model: req.model,
    });
  const p: Provider & Calls = {
    name: 'anthropic',
    writer: 0,
    judge: 0,
    workerPrompts: [],
    complete(req) {
      const sys = req.system.map((b) => b.text).join('\n');
      if (sys.includes(WRITER)) {
        p.writer++;
        // The first answer is unusable (no files); the one retry gets the suite.
        return answer(req, p.writer === 1 ? {} : SUITE);
      }
      if (sys.includes(JUDGE)) {
        p.judge++;
        return answer(req, { drop: judgeDrop(p.judge), reason: `ruling ${p.judge}` });
      }
      const text = req.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n');
      if (text.includes('Work on M2.T01')) p.workerPrompts.push(text);
      return scripted.complete(req);
    },
  };
  return p;
}

async function runWith(p: Provider, extra: ConfigInput = {}, goal = GOAL) {
  const review = {
    enabled: false,
    audit: false,
    strict_checks: false,
    spec_tests: 'on' as const,
    ...extra.review,
  };
  const config: ConfigInput = { ...extra, review };
  const t = await startTestRun({
    repo: await makeRepo(),
    provider: p,
    goal,
    config: { gates: [GATE], ...config },
  });
  const out = await supervise(t.run.deps, t.run.state.runId, {
    bootId: 'b',
    heartbeatMs: 50,
    controlPollMs: 20,
    pausePollMs: 10,
  });
  const events = await readEvents(t.run.store.eventsPath);
  return { t, out, events, of: (type: string) => events.filter((e) => e.type === type) };
}

describe('spec-first acceptance tests before finishing', () => {
  it('sends a failing spec test back to the worker as evidence and finishes once it passes', async () => {
    const p = provider(fileWorker, () => []);
    const { t, out, of } = await runWith(p, { plan: { mode: 'full' } });
    expect(out.status).toBe('finished');
    expect(p.writer).toBe(2);
    expect(of('spec_tests.result').map((e) => e.pass)).toEqual([false, true]);
    expect(of('spec_tests.fix').map((e) => e.task)).toEqual(['M2.T01']);
    const plan = await t.run.store.readPlan();
    expect(plan?.nodes.find((n) => n.id === 'M2.T01')?.status).toBe('done');
    // The failing test reached the worker as evidence.
    expect(p.workerPrompts.join('\n')).toContain('fulfil re-checked available stock');
    // The suite never lands in a commit, and is gone from the worktree.
    const files = (await git(t.run.worktree, ['ls-files'])).stdout;
    expect(files).not.toContain('omnexx-spec');
    expect((await t.run.store.readState()).specTests).toMatchObject({ status: 'passed' });
  });

  it('lets the judge drop a disputed spec test, after rejecting a first dispute', async () => {
    // The fix task only disputes; the judge rejects the first dispute (the ruling goes back to
    // the worker) and upholds the second, which drops the test.
    const worker: Script = (m) => {
      if (m.taskId?.startsWith('M1')) return fileWorker(m);
      if (m.turn > 0) return say('Disputed the spec test.');
      return call('write_file', {
        path: '.omnexx-spec-dispute.md',
        content: `${SPEC_FILE}: the goal never asks for out/M2.T01.txt`,
      });
    };
    const p = provider(worker, (n) => (n === 1 ? [] : [SPEC_FILE]));
    const { t, out, of } = await runWith(p, { plan: { mode: 'full' } });
    expect(out.status).toBe('finished');
    expect(p.judge).toBe(2);
    expect(of('spec_tests.dispute').map((e) => e.dropped)).toEqual([[], [SPEC_FILE]]);
    expect(of('spec_tests.fix').map((e) => e.task)).toEqual(['M2.T01']);
    expect(p.workerPrompts.join('\n')).toContain('Your dispute was not upheld: ruling 1');
    expect((await t.run.store.readState()).specTests).toMatchObject({ status: 'passed' });
    expect((await git(t.run.worktree, ['ls-files'])).stdout).not.toContain('dispute');
  });

  it('reverts a fix round that left as many spec tests failing, and finishes on the last green', async () => {
    const worker: Script = (m) =>
      m.taskId?.startsWith('M1') ? fileWorker(m) : fileWorker({ ...m, taskId: `${m.taskId}-x` });
    const p = provider(worker, () => []);
    const { t, out, of } = await runWith(p, { plan: { mode: 'full' } });
    expect(out.status).toBe('finished');
    expect(of('spec_tests.result').map((e) => [e.pass, e.failed])).toEqual([
      [false, 1],
      [false, 1],
    ]);
    const [reverted] = of('spec_tests.reverted');
    expect(reverted).toMatchObject({ failedBefore: 1, failedAfter: 1 });
    // The round's commit is gone: the worktree is back where the round started.
    expect((await git(t.run.worktree, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(reverted?.to);
    expect((await git(t.run.worktree, ['ls-files'])).stdout).not.toContain('M2.T01-x');
    expect((await t.run.store.readState()).specTests).toMatchObject({ status: 'failed-open' });
  });

  it('cuts a fix round off after spec_tests_max_cycles and finishes', async () => {
    const worker: Script = (m) =>
      m.taskId?.startsWith('M1') ? fileWorker(m) : say('I could not find what to change.');
    const p = provider(worker, () => []);
    const { out, of } = await runWith(p, {
      plan: { mode: 'full' },
      review: { spec_tests_max_cycles: 1 },
    });
    expect(out.status).toBe('finished');
    expect(of('spec_tests.budget_spent')).toEqual([
      expect.objectContaining({ task: 'M2.T01', cycles: 1 }),
    ]);
    expect(of('spec_tests.failed_open')).toHaveLength(1);
  });

  it('is off by default, and costs nothing in auto mode for a small goal', async () => {
    const off = provider(fileWorker, () => []);
    const r1 = await runWith(off, { review: { spec_tests: undefined } });
    expect(r1.out.status).toBe('finished');
    const small = provider(fileWorker, () => []);
    const r2 = await runWith(
      small,
      { review: { spec_tests: 'auto' } },
      'Make the test suite pass.',
    );
    expect(r2.out.status).toBe('finished');
    expect(off.writer + small.writer).toBe(0);
  });
});
