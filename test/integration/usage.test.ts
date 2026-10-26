import { readFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import { CALL_PURPOSES, parseLedger } from '../../src/usage/ledger.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { ScriptedProvider } from '../support/scripted-provider.js';
import { makeRepo, startTestRun, type TestRun } from '../support/harness.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};

const fastOpts = {
  bootId: 'usage',
  heartbeatMs: 50,
  controlPollMs: 20,
  pausePollMs: 10,
  notifier: { notify: () => Promise.resolve() },
};

async function superviseTest(t: TestRun) {
  return supervise(t.run.deps, t.run.state.runId, fastOpts);
}

async function cli(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => (out += c.toString()));
  stderr.on('data', (c: Buffer) => (err += c.toString()));
  const io: CliIO = { stdout, stderr, stdin: Readable.from([]), env, cwd, isTTY: false };
  const code = await runCli(argv, io);
  // eslint-disable-next-line no-control-regex
  const plain = (x: string): string => x.replace(/\u001b\[[0-9;]*m/g, '');
  return { code, out: plain(out), err: plain(err) };
}

describe('usage attribution', () => {
  it('accounts for every provider call with a task, purpose, cycle and step', async () => {
    const plan = planner([
      {
        id: 'M1',
        title: 'Files',
        tasks: [fileTask('M1.T01'), fileTask('M1.T02')],
      },
    ]);
    const provider = new ScriptedProvider(scenario(plan, fileWorker));
    const t = await startTestRun({ repo: await makeRepo(), provider, config: { gates: [GATE] } });
    await superviseTest(t);

    const records = parseLedger(await readFile(t.run.store.file('usage-ledger.jsonl'), 'utf8'));
    const calls = records.filter((r) => r.kind === 'call');
    // Every request the provider saw has exactly one ledger record, and nothing else does.
    expect(calls).toHaveLength(provider.requests.length);
    for (const call of calls) {
      expect(CALL_PURPOSES).toContain(call.purpose);
      expect(call.taskId.length).toBeGreaterThan(0);
      expect(call.cycle).toBeGreaterThanOrEqual(0);
      expect(call.step).toBeGreaterThanOrEqual(0);
      expect(call.requestHash).toMatch(/^[0-9a-f]{16}$/);
    }
    const tasks = new Set(calls.map((c) => c.taskId));
    expect(tasks).toContain('plan');
    expect(tasks).toContain('M1.T01');
    expect(tasks).toContain('M1.T02');
    expect(t.run.ledger.taskTotals('M1.T01').calls).toBeGreaterThan(1);
  });

  it('prints the per-task breakdown and its waste section, and --json is machine-readable', async () => {
    const plan = planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, fileWorker)),
      config: { gates: [GATE] },
    });
    await superviseTest(t);
    const run = (a: string[]) => cli(a, t.env, t.repo);

    const json = JSON.parse((await run(['usage', 'M1.T01', '--json'])).out) as {
      taskId: string;
      calls: number;
      byPurpose: { purpose: string; calls: number }[];
      waste: { repeatReads: { count: number }; retries: { calls: number } };
    };
    expect(json.taskId).toBe('M1.T01');
    expect(json.calls).toBeGreaterThan(0);
    expect(json.byPurpose.map((p) => p.purpose)).toContain('main');
    expect(json.waste.repeatReads.count).toBe(0);
    expect(json.waste.retries.calls).toBe(0);

    const text = await run(['usage', 'M1.T01']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('task M1.T01');
    expect(text.out).toContain('by purpose');
    expect(text.out).toContain('repeat reads');
    expect(text.out).toContain('avoidable');
  });

  it('parks a task at its cap with a checkpoint instead of letting it burn the run', async () => {
    const plan = planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]);
    // The first turn only reads, so the cap stops the task before its write: partial work is
    // incomplete and the park is what the test is looking at.
    const slowWorker = (m: { taskId: string | undefined; turn: number }) =>
      m.turn === 0
        ? { tools: [{ name: 'read', input: { path: 'package.json' } }] }
        : {
            tools: [
              {
                name: 'write_file',
                input: { path: `out/${m.taskId ?? 'unknown'}.txt`, content: `${m.taskId ?? ''}\n` },
              },
            ],
          };
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, slowWorker)),
      config: {
        gates: [GATE],
        models: {
          planner: 'anthropic:sonnet',
          worker: 'anthropic:sonnet',
          cheap: 'anthropic:sonnet',
        },
        providers: { anthropic: { max_tokens: 200 } },
        budget: { max_task_usd: 0.02, max_task_tokens: 10_000_000 },
      },
    });
    const out = await superviseTest(t);
    const events = await readEvents(t.run.store.eventsPath);
    const parked = events.find((e) => e.type === 'budget.task_park');
    expect(parked, `outcome ${out.status}: ${out.reason}`).toBeDefined();
    expect(parked).toMatchObject({ task: 'M1.T01' });
    const savedPlan = await t.run.store.readPlan();
    const task = savedPlan?.nodes.find((n) => n.id === 'M1.T01');
    expect(task?.status).toBe('parked');
    expect(task?.parkedReason).toMatch(/task budget/);
    expect(await readFile(t.run.store.file('usage-ledger.jsonl'), 'utf8')).toContain(
      '"taskId":"M1.T01"',
    );
  });

  it('falls back to state.json totals for a run with no ledger', async () => {
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(() => ({ text: 'noop' })),
      config: { gates: [GATE] },
    });
    const r = await cli(['usage', t.run.state.runId], t.env, t.repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no usage ledger');
    expect(r.out).toContain('state.json totals');
  });
});
