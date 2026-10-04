import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import { readEvents } from '../../src/core/events.js';
import { resolvePaths } from '../../src/core/paths.js';
import { git } from '../../src/git/git.js';
import { commitMessage, headSha, isClean } from '../../src/git/repo.js';
import { parseTrailers } from '../../src/git/trailers.js';
import { runWorkerCycle } from '../../src/workers/lifecycle.js';
import { QuotaStore, Semaphore } from '../../src/workers/quota.js';
import { fakeBackend } from '../support/fake-backend.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { ScriptedProvider, say } from '../support/scripted-provider.js';
import { secretCorpus, secretValues } from '../support/secrets.js';
import { isolatedEnv, tempDir } from '../support/tmp.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};
const plan = {
  milestones: [
    {
      id: 'M1',
      title: 'Work',
      tasks: [
        {
          id: 'M1.T01',
          title: 'Create out/x.txt',
          checks: ['test -f out/x.txt'],
          kind: 'tests' as const,
          size: 'S' as const,
        },
      ],
    },
  ],
};

async function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const env = await isolatedEnv({
    ANTHROPIC_API_KEY: secretCorpus().anthropic,
    GITHUB_TOKEN: secretCorpus().github,
    ...extraEnv,
  });
  const t = await startTestRun({
    repo: await makeRepo(),
    provider: new ScriptedProvider(() => say('unused')),
    plan,
    env,
    config: { gates: [GATE] },
  });
  const deps = {
    quota: new QuotaStore(resolvePaths(env).home),
    semaphore: new Semaphore(defaultConfig().workers.max_concurrent),
  };
  return { t, deps, scenarios: await tempDir() };
}

describe('worker backends: harness-side lifecycle with the fake worker', () => {
  it('a scripted patch (even one the worker committed itself) becomes one commit with an Omnexx-Worker trailer; env and logs carry no secrets', async () => {
    const { t, deps, scenarios } = await setup();
    const backend = fakeBackend(scenarios, {
      mode: 'patch',
      commit: true,
      files: { 'out/x.txt': 'x\n' },
    });
    const r = await runWorkerCycle(t.run, backend, 'M1.T01', deps);
    expect(r).toMatchObject({
      ran: true,
      verdict: 'accept',
      outcome: { status: 'completed', summary: 'applied the scripted patch' },
    });
    const sha = await headSha(t.run.worktree);
    expect(parseTrailers(await commitMessage(t.run.worktree, sha))).toEqual({
      run: t.run.state.runId,
      task: 'M1.T01',
      cycle: 1,
      worker: 'fake',
    });
    expect(
      (await git(t.run.worktree, ['rev-list', '--count', `${t.run.state.startRef}..HEAD`])).stdout,
    ).toBe('1');
    // The worker's own branch and worktree are gone.
    expect((await git(t.repo, ['branch', '--list', '*-w-*'])).stdout).toBe('');
    const logs = await readdir(t.run.store.logsDir);
    const workerLog = await readFile(
      join(t.run.store.logsDir, logs.find((f) => f === 'worker-fake-1.log') ?? ''),
      'utf8',
    );
    expect(workerLog).toContain('fake-worker env:');
    expect(workerLog).toContain('GIT_CONFIG_KEY_0');
    expect(workerLog).not.toMatch(/ANTHROPIC_API_KEY|GITHUB_TOKEN/);
    for (const f of logs)
      for (const s of secretValues())
        expect(await readFile(join(t.run.store.logsDir, f), 'utf8')).not.toContain(s);
    expect(JSON.stringify(await readEvents(t.run.store.eventsPath))).not.toContain(
      secretCorpus().anthropic,
    );
  });

  it('push is disabled inside the worker', async () => {
    const { t, deps, scenarios } = await setup();
    const bare = await tempDir();
    await git(bare, ['init', '-q', '--bare']);
    await git(t.repo, ['remote', 'add', 'origin', bare]);
    await runWorkerCycle(
      t.run,
      fakeBackend(scenarios, { mode: 'push', files: { 'out/x.txt': 'x\n' } }),
      'M1.T01',
      deps,
    );
    const log = await readFile(join(t.run.store.logsDir, 'worker-fake-1.log'), 'utf8');
    expect(log).toContain('push: refused');
    expect((await git(bare, ['branch', '--list'])).stdout).toBe('');
  });

  it('a timeout kills the whole process tree (no orphans) and the cycle is rolled back', async () => {
    const { t, deps, scenarios } = await setup();
    const pidFile = join(scenarios, 'child.pid');
    const r = await runWorkerCycle(
      t.run,
      fakeBackend(
        scenarios,
        { mode: 'hang', pidFile, files: { 'out/x.txt': 'x\n' } },
        { timeoutMs: 1_500 },
      ),
      'M1.T01',
      deps,
    );
    expect(r).toMatchObject({ ran: true, verdict: 'reject', outcome: { status: 'timeout' } });
    const child = Number(await readFile(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 1_500));
    expect(() => process.kill(child, 0)).toThrow();
    expect(await isClean(t.run.worktree)).toBe(true);
    expect(await headSha(t.run.worktree)).toBe(t.run.state.startRef);
  });

  it('a worker that deletes a test is rejected by anti-cheat', async () => {
    const { t, deps, scenarios } = await setup();
    const r = await runWorkerCycle(
      t.run,
      fakeBackend(scenarios, {
        mode: 'patch',
        deleteFile: 'test/ok.test.js',
        files: { 'out/x.txt': 'x\n' },
      }),
      'M1.T01',
      deps,
    );
    expect(r).toMatchObject({ ran: true, verdict: 'reject' });
    const v = (await readEvents(t.run.store.eventsPath)).find((e) => e.type === 'verify.result');
    expect(JSON.stringify(v?.reasons)).toContain('anti-cheat deleted-test');
    expect(await readFile(t.run.store.file('rejected/1-fake.patch'), 'utf8')).toContain(
      'test/ok.test.js',
    );
  });

  it('ref tampering rejects the result and disables the worker for the run', async () => {
    const { t, deps, scenarios } = await setup();
    const r = await runWorkerCycle(
      t.run,
      fakeBackend(scenarios, { mode: 'tamper', files: { 'out/x.txt': 'x\n' } }),
      'M1.T01',
      deps,
    );
    expect(r).toMatchObject({ ran: true, verdict: 'reject', tampered: ['refs/heads/evil'] });
    expect(t.run.state.disabledWorkers).toEqual(['fake']);
    expect(
      await runWorkerCycle(
        t.run,
        fakeBackend(scenarios, { mode: 'patch', files: { 'out/x.txt': 'x\n' } }),
        'M1.T01',
        deps,
      ),
    ).toEqual({ ran: false, reason: 'disabled for this run' });
    expect((await readEvents(t.run.store.eventsPath)).some((e) => e.type === 'worker.tamper')).toBe(
      true,
    );
  });

  it('quota_exhausted puts the worker in cooldown, persisted across a restart', async () => {
    const { t, deps, scenarios } = await setup();
    const r = await runWorkerCycle(
      t.run,
      fakeBackend(scenarios, { mode: 'quota' }),
      'M1.T01',
      deps,
    );
    expect(r).toMatchObject({
      ran: true,
      outcome: { status: 'quota_exhausted' },
      verdict: 'reject',
    });
    // A fresh QuotaStore (as after a supervisor restart) reads the same state from disk.
    const reopened = new QuotaStore(resolvePaths(t.env).home);
    const again = await runWorkerCycle(
      t.run,
      fakeBackend(scenarios, { mode: 'patch', files: { 'out/x.txt': 'x\n' } }),
      'M1.T01',
      { ...deps, quota: reopened },
    );
    expect(again.ran).toBe(false);
    expect(!again.ran && again.reason).toMatch(/cooling down/);
    const blocked = await reopened.blocked(
      'fake',
      { maxRunsPerHour: 10, maxRunsPerDay: 40, cooldownMs: 1 },
      t.clock.now() + 2 * 3_600_000,
    );
    expect(blocked).toBeUndefined();
  });

  it('max_concurrent = 1 is never exceeded', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const release = await sem.acquire();
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        release();
        release(); // double release is harmless
      }),
    );
    expect(peak).toBe(1);
    expect(sem.peak).toBe(1);
  });

  it('a failing worker is rolled back; hourly caps block further runs', async () => {
    const { t, deps, scenarios } = await setup();
    expect(
      await runWorkerCycle(
        t.run,
        fakeBackend(scenarios, { mode: 'fail', files: { 'out/x.txt': 'x\n' } }),
        'M1.T01',
        deps,
      ),
    ).toMatchObject({ verdict: 'reject', outcome: { status: 'failed' } });
    const capped = fakeBackend(scenarios, { mode: 'fail' }, { id: 'capped' });
    const policy = { ...capped.quota, maxRunsPerHour: 1 };
    await deps.quota.record('capped', 'failed', policy, t.clock.now());
    expect(await deps.quota.blocked('capped', policy, t.clock.now())).toMatch(
      /runs in the last hour/,
    );
    expect(
      await deps.quota.blocked(
        'capped',
        { ...policy, maxRunsPerHour: 5, maxRunsPerDay: 1 },
        t.clock.now(),
      ),
    ).toMatch(/last day/);
  });
});
