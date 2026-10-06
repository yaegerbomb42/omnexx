import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { listRunIds, RunStore } from '../../src/core/run-store.js';
import { resolvePaths } from '../../src/core/paths.js';
import { isClean } from '../../src/git/repo.js';
import { secretCorpus } from '../support/secrets.js';
import { fixtureRepo, startTestRun } from '../support/harness.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { isolatedEnv } from '../support/tmp.js';
import { FakeClock } from '../support/clock.js';

const planScript: Script = ({ planner, turn }) => {
  if (!planner) return say('not a planner request');
  return (
    [
      call('read', { path: 'src/math.js' }),
      call('write_plan', {
        milestones: [
          { id: 'M1', title: 'Fix', tasks: [{ id: 'M1.T01', title: 'bad', dependsOn: ['M9'] }] },
        ],
      }),
      call('write_plan', {
        milestones: [
          {
            id: 'M1',
            title: 'Fix arithmetic',
            checks: ['node --test'],
            tasks: [
              {
                id: 'M1.T01',
                title: 'Make add() add',
                checks: ['node --test'],
                size: 'S',
                kind: 'feature',
              },
            ],
          },
          { id: 'M2', title: 'Harden later' },
        ],
      }),
      say('Plan written.'),
    ][turn] ?? say('done')
  );
};

async function cliRun(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  provider: ScriptedProvider,
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => (out += c.toString()));
  stderr.on('data', (c: Buffer) => (err += c.toString()));
  const io: CliIO = {
    stdout,
    stderr,
    stdin: Readable.from([]),
    env,
    cwd,
    isTTY: false,
    makeProvider: () => provider,
    clock: new FakeClock(),
    fetch: () => Promise.reject(new Error('no network')),
  };
  const code = await runCli(argv, io);
  return { code, out, err };
}

describe('run --plan-only', () => {
  it('runs the planner with read-only tools, retries a rejected plan, writes plan.json, never edits the repo', async () => {
    const repo = await fixtureRepo('ts-failing-test');
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: secretCorpus().anthropic });
    const provider = new ScriptedProvider(planScript);
    const r = await cliRun(['run', '--plan-only', 'Make the tests pass'], repo, env, provider);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[ ] M1 Fix arithmetic (0/1 tasks)');
    expect(r.out).toContain('[ ] M2 Harden later');
    const [runId] = await listRunIds(resolvePaths(env));
    const store = new RunStore(resolvePaths(env), runId ?? '');
    expect((await store.readState()).status).toBe('planned');
    expect((await store.readPlan())?.nodes.map((n) => n.id)).toEqual(['M1', 'M1.T01', 'M2']);
    expect(provider.requests[0]?.tools.map((t) => t.name).sort()).toEqual([
      'outline',
      'read',
      'read_log',
      'remember',
      'search',
      'write_intent',
      'skill',
      'write_plan',
    ]);
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toMatch(
      /plan rejected: .*unknown node M9/,
    );
    expect(await isClean(repo)).toBe(true);
    const events = await readEvents(store.eventsPath);
    expect(events.map((e) => e.type)).toContain('plan.written');
    expect(JSON.stringify(events)).not.toContain(secretCorpus().anthropic);
  });

  it('fails clearly without a key or goal, and multi-cycle runs say they need M2', async () => {
    const repo = await fixtureRepo('ts-failing-test');
    const provider = new ScriptedProvider(planScript);
    expect(
      (await cliRun(['run', '--plan-only', 'x'], repo, await isolatedEnv(), provider)).err,
    ).toMatch(/no Anthropic API key/);
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
    expect((await cliRun(['run', '--plan-only'], repo, env, provider)).err).toMatch(/missing goal/);
    expect(
      (await cliRun(['run', '--plan-only', '--budget', '-1', 'x'], repo, env, provider)).err,
    ).toMatch(/positive number/);
    await writeFile(join(repo, 'GOAL.md'), 'goal from file');
    expect((await cliRun(['run', 'x', '--goal-file', 'GOAL.md'], repo, env, provider)).err).toMatch(
      /not both/,
    );
    expect(
      (await cliRun(['run', '--plan-only', '--sandbox', 'vm', 'x'], repo, env, provider)).err,
    ).toMatch(/config error.*sandbox/);
  });
});

describe('agent loop limits and control inside a cycle', () => {
  const plan = {
    milestones: [
      {
        id: 'M1',
        title: 'Fix math',
        tasks: [{ id: 'M1.T01', title: 'Make add() add', checks: ['node --test'] }],
      },
    ],
  };
  const fixThenTalk: Script = ({ turn }) =>
    turn === 0
      ? call('str_replace', {
          path: 'src/math.js',
          old_str: 'return a - b;',
          new_str: 'return a + b;',
        })
      : call('bash', { command: `true ${turn}` });

  it('a tiny max_usd ends the cycle at the pre-flight check; work that passes the gates is still kept', async () => {
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: new ScriptedProvider(fixThenTalk),
      plan,
      config: {
        budget: { max_usd: 0.1 },
        providers: { anthropic: { max_tokens: 1_000 } },
        stuck: { no_edit_turns: 1_000 },
      },
    });
    await runBaseline(t.run);
    const v = await runOneCycle(t.run, 'M1.T01');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.find((e) => e.type === 'budget.preflight_stop')).toMatchObject({
      stop: 'max_usd',
    });
    expect(t.run.state.spend.usd).toBeLessThanOrEqual(0.1);
    expect(v).toMatchObject({ verdict: 'accept', done: true });
  });

  it('max_turns_per_cycle ends the loop; partial work that fails the gates is rolled back', async () => {
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: new ScriptedProvider(({ turn }) =>
        turn === 0
          ? call('write_file', {
              path: 'src/math.js',
              content: 'export function add(a, b) {\n  return a +\n',
            })
          : call('bash', { command: 'true' }),
      ),
      plan,
      config: { budget: { max_turns_per_cycle: 3 } },
    });
    await runBaseline(t.run);
    const v = await runOneCycle(t.run, 'M1.T01');
    expect(
      (await readEvents(t.run.store.eventsPath)).find((e) => e.type === 'budget.preflight_stop'),
    ).toMatchObject({ stop: 'max_turns_per_cycle' });
    expect(v.verdict).toBe('reject');
    expect(await isClean(t.run.worktree)).toBe(true);
  });

  it('pause blocks at a turn boundary and resume continues; stop ends the loop; unknown tools and bad input are errors', async () => {
    let turnSeen = 0;
    const script: Script = ({ turn }) => {
      turnSeen = turn;
      return (
        [
          call('nope', {}),
          call('read', { wrong: 1 }),
          call('str_replace', {
            path: 'src/math.js',
            old_str: 'return a - b;',
            new_str: 'return a + b;',
          }),
          say('done'),
        ][turn] ?? say('done')
      );
    };
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: new ScriptedProvider(script),
      plan,
    });
    await runBaseline(t.run);
    await t.run.store.writeControl({ request: 'pause', at: 1 });
    // Resume after the loop has been paused for a while (fake clock sleeps advance instantly).
    let polls = 0;
    const realControl = t.run.control.bind(t.run);
    t.run.control = async () => {
      const c = await realControl();
      if (c === 'pause' && ++polls === 5)
        await t.run.store.writeControl({ request: 'resume', at: 2 });
      return c;
    };
    const v = await runOneCycle(t.run, 'M1.T01');
    expect(v.verdict).toBe('accept');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.map((e) => e.type).filter((x) => x.startsWith('control.'))).toEqual([
      'control.paused',
      'control.resumed',
    ]);
    const calls = events.filter((e) => e.type === 'tool.call');
    expect(calls.slice(0, 2).map((e) => e.isError)).toEqual([true, true]);
    expect(turnSeen).toBe(3);

    const stopped = await startTestRun({
      fixture: 'ts-failing-test',
      provider: new ScriptedProvider(fixThenTalk),
      plan,
    });
    await runBaseline(stopped.run);
    await stopped.run.store.writeControl({ request: 'stop', at: 1 });
    expect((await runOneCycle(stopped.run, 'M1.T01')).reasons).toEqual(['no changes']);
  });

  it('judge off: a whole cycle makes zero HTTP calls', async () => {
    let calls = 0;
    const counting = (() => {
      calls++;
      return Promise.reject(new Error('no network'));
    }) as typeof fetch;
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: new ScriptedProvider(fixThenTalk),
      plan,
      fetch: counting,
      config: { budget: { max_turns_per_cycle: 3 } },
    });
    await runBaseline(t.run);
    await runOneCycle(t.run, 'M1.T01');
    expect(calls).toBe(0);
    expect(await readFile(t.run.store.eventsPath, 'utf8')).not.toContain('judge.');
  });
});
