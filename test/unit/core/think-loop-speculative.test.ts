import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoopDeps } from '../../../src/agent/loop.js';
import { gateSchema } from '../../../src/config/schema.js';
import type { PlanNode } from '../../../src/core/plan.js';
import type { Run } from '../../../src/core/run.js';
import { speculativeChecks, withSpeculation } from '../../../src/core/think-loop-speculative.js';
import { git } from '../../../src/git/git.js';
import { headSha, workingTreeHash } from '../../../src/git/repo.js';
import { FakeClock } from '../../support/clock.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

const task = { id: 'T1' } as PlanNode;

async function fakeRun(over: { speculative?: boolean; gates?: object[] } = {}) {
  const repo = await tempRepo();
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const commands: string[] = [];
  const events: string[] = [];
  const run = {
    config: {
      plan: { speculative_checks: over.speculative ?? true },
      gates: (over.gates ?? [{ name: 'test', run: 'npm test' }]).map((g) => gateSchema.parse(g)),
    },
    clock: new FakeClock(),
    worktree: repo,
    state: { lastGreen: await headSha(repo), cycle: 3 },
    childEnv: {},
    signal: new AbortController().signal,
    store: { logsDir: await tempDir() },
    maxCmdTimeoutMs: 60_000,
    redactor: { text: (s: string) => s },
    events: { emit: (type: string) => events.push(type) },
    exec: (cmd: string) => {
      commands.push(cmd);
      return Promise.resolve({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        output: '',
        durationMs: 1,
      });
    },
  } as unknown as Run;
  return { run, repo, commands, events };
}

describe('think-loop speculative checks', () => {
  it('is off when configured off or when only browser gates exist', async () => {
    expect(speculativeChecks((await fakeRun({ speculative: false })).run, task)).toBeUndefined();
    const browserOnly = await fakeRun({
      gates: [{ name: 'ui', kind: 'browser', run: 'npm start', url: 'http://x' }],
    });
    expect(speculativeChecks(browserOnly.run, task)).toBeUndefined();
  });

  it('runs the gates after an edit and hands the result back for the same tree', async () => {
    const { run, repo, commands, events } = await fakeRun();
    const spec = speculativeChecks(run, task);
    if (!spec) throw new Error('speculative checks should be on');
    const touched: string[] = [];
    const deps = withSpeculation(
      { toolCtx: { onEdit: (p: string) => touched.push(p) } } as unknown as LoopDeps,
      spec,
    );

    await writeFile(join(repo, 'a.txt'), 'two\n');
    deps.toolCtx.onEdit?.('a.txt');
    const tree = await workingTreeHash(repo, run.state.lastGreen);
    const hit = await spec.take(tree);
    await spec.stop();

    expect(touched).toEqual(['a.txt']);
    expect(commands).toEqual(['npm test']);
    expect(hit?.results.map((r) => r.name)).toEqual(['test']);
    expect(hit?.results[0]?.logFile).toContain('gate-c3-spec1-test.log');
    expect(events).toEqual(['loop.speculative_ready', 'loop.speculative_hit']);
  });

  it('leaves deps alone when speculation is off', () => {
    const deps = { toolCtx: {} } as unknown as LoopDeps;
    expect(withSpeculation(deps, undefined)).toBe(deps);
  });
});
