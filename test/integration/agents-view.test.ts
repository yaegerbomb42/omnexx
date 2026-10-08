import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { loadAgents } from '../../src/tui/agents.js';
import { Session } from '../../src/tui/session.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { ScriptedProvider, say } from '../support/scripted-provider.js';
import { isolatedEnv } from '../support/tmp.js';
import { resolvePaths } from '../../src/core/paths.js';

const plan = {
  milestones: [
    {
      id: 'M1',
      title: 'Work',
      tasks: [
        { id: 'M1.T01', title: 'one', checks: [] },
        { id: 'M1.T02', title: 'two', checks: [] },
      ],
    },
  ],
};

describe('/agents', () => {
  it('lists every long run with progress and lets you attach', async () => {
    const env = await isolatedEnv();
    const provider = new ScriptedProvider(() => say('ok'));
    const a = await startTestRun({
      repo: await makeRepo(),
      provider,
      plan,
      env,
      goal: 'Build the parser',
    });
    const b = await startTestRun({
      repo: await makeRepo(),
      provider,
      plan,
      env,
      goal: 'Fix the login bug',
    });
    const node = a.run.plan?.nodes.find((n) => n.id === 'M1.T01');
    if (node) node.status = 'done';
    await a.run.savePlan();
    a.run.state.status = 'finished';
    a.run.state.spend.usd = 1.25;
    await a.run.save();

    const rows = await loadAgents(resolvePaths(env), Date.now());
    expect(rows.map((r) => [r.goal, r.status, r.done, r.tasks])).toEqual(
      expect.arrayContaining([
        ['Build the parser', 'finished', 1, 2],
        ['Fix the login bug', 'running', 0, 2],
      ]),
    );
    expect(rows.find((r) => r.goal === 'Build the parser')?.usd).toBe(1.25);

    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: a.repo,
      isTTY: false,
    } as CliIO;
    const s = new Session(io, () => Promise.resolve(0));
    await s.submit('/agents');
    expect(s.agentsView?.rows).toHaveLength(2);
    const target = s.agentsView?.rows[1]?.runId;
    await s.agentsKey('down');
    await s.agentsKey('attach');
    expect(s.agentsView).toBeUndefined();
    expect(s.runId).toBe(target);
    expect([a.run.state.runId, b.run.state.runId]).toContain(target);
  });
});
