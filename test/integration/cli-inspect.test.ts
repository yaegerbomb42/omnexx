import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import { supervise } from '../../src/core/supervisor.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { ScriptedProvider } from '../support/scripted-provider.js';
import { makeRepo, startTestRun } from '../support/harness.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};

async function cli(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => (out += c.toString()));
  stderr.on('data', (c: Buffer) => (err += c.toString()));
  const io: CliIO = { stdout, stderr, stdin: Readable.from([]), env, cwd, isTTY: false };
  const code = await runCli(argv, io);
  // picocolors enables color when CI is set; compare plain text.
  // eslint-disable-next-line no-control-regex
  const plain = (x: string): string => x.replace(/\u001b\[[0-9;]*m/g, '');
  return { code, out: plain(out), err: plain(err) };
}

describe('inspection commands on a finished run', () => {
  it('status, status --json, runs, logs, plan, diff, checkpoints, report, and control requests', async () => {
    const plan = planner([
      { id: 'M1', title: 'First', checks: ['test -f out/M1.T01.txt'], tasks: [fileTask('M1.T01')] },
      { id: 'M2', title: 'Second', dependsOn: ['M1'], tasks: [fileTask('M2.T01')] },
    ]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, fileWorker)),
      config: { gates: [GATE] },
    });
    await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
    });
    const id = t.run.state.runId;
    const run = (a: string[]) => cli(a, t.env, t.repo);

    const status = await run(['status']);
    expect(status.out).toContain(`${id} `);
    expect(status.out).toMatch(/finished/);
    expect(status.out).toMatch(/tasks 2\/2 done/);
    const json = JSON.parse((await run(['status', id, '--json'])).out) as Record<string, unknown>;
    expect(json).toMatchObject({
      status: 'finished',
      commits: 2,
      checkpoints: 2,
      supervisorAlive: false,
      tasks: { done: 2, tasks: 2 },
    });
    expect(json.spend).toMatchObject({
      cacheHitRatio: expect.any(Number) as number,
      usdPerAcceptedCommit: expect.any(Number) as number,
      tokens: { cacheRead: expect.any(Number) as number },
    });

    expect((await run(['runs'])).out).toContain(`${id}  finished`);
    const logs = await run(['logs', id]);
    expect(logs.out).toMatch(/cycle 1\s+task M1\.T01/);
    expect(logs.out).toMatch(/accept\s+M1\.T01 \(done\)/);
    expect((await run(['logs', '--events'])).out.split('\n')[0]).toMatch(/^\{"ts":/);
    expect((await run(['logs', '--progress'])).out).toContain('## Cycle 1');
    expect((await run(['logs', '--cmd', 'gate-c1-test'])).out).toContain('TAP version');
    expect((await run(['logs', '--cmd', '../x'])).err).toMatch(/bad log id/);
    expect((await run(['plan'])).out).toContain('[x] M1 First (1/1 tasks)');
    expect((await run(['diff'])).out).toContain('out/M1.T01.txt');
    expect((await run(['diff', '--since', 'M1'])).out).toContain('out/M2.T01.txt');
    expect((await run(['diff', '--since', 'M1'])).out).not.toContain('out/M1.T01.txt');
    expect((await run(['diff', '--since', 'M9'])).err).toMatch(/no checkpoint for M9/);
    const cps = (await run(['checkpoints'])).out;
    expect(cps).toMatch(/^M1 +[0-9a-f]{10}/m);
    expect(cps).toContain(`omnexx/${id}/M2`);
    expect((await run(['report', id])).out).toContain('## 8. How to review and merge');

    expect((await run(['pause'])).out).toMatch(/no supervisor is running/);
    expect((await run(['stop', '--now'])).out).toMatch(/stop-now requested/);
    expect((await run(['resume', id])).err).toMatch(/already finished/);
    expect((await run(['resume', id, '--all'])).err).toMatch(/not both/);
    expect((await run(['status', 'r_nope'])).err).toMatch(/no run r_nope/);
  });

  it('commands without any runs say so; run without gates is refused', async () => {
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(() => ({})),
      config: { gates: [GATE] },
    });
    const empty = { ...t.env, OMNEXX_HOME: `${String(t.env.OMNEXX_HOME)}-empty` };
    expect((await cli(['status'], empty, t.repo)).err).toMatch(/no runs yet/);
    expect((await cli(['runs'], empty, t.repo)).out).toContain('no runs yet');
    const withKey = { ...empty, ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' };
    expect((await cli(['run', 'do things'], withKey, t.repo)).err).toMatch(/no gates configured/);
  });
});
