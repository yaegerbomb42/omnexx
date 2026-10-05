import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import { DockerSandbox, dockerAvailable } from '../../src/security/sandbox-docker.js';
import { scrubEnv } from '../../src/security/env-scrub.js';
import { tempDir } from '../support/tmp.js';

const available = await dockerAvailable(process.env);
const started: DockerSandbox[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.stop()));
});

async function sandbox(network: 'bridge' | 'none' = 'none') {
  const worktree = await tempDir('omnexx-sbx-');
  const tmp = await tempDir('omnexx-sbx-tmp-');
  const s = new DockerSandbox(
    {
      name: `omnexx-test-${Math.random().toString(36).slice(2, 8)}`,
      worktree,
      tmpDir: tmp,
      gitDir: undefined,
      docker: defaultConfig({
        docker: { image: 'node:22-bookworm-slim', network, memory: '512m', cpus: '1' },
      }).docker,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    },
    process.env,
  );
  await s.start();
  started.push(s);
  return { s, worktree, tmp };
}

// Runs where a docker daemon is reachable (CI on ubuntu). Skipped elsewhere.
describe.skipIf(!available)('docker sandbox (real containers)', () => {
  it('runs commands in the worktree as the host user, with the scrubbed env only', async () => {
    const { s, worktree } = await sandbox();
    const r = await s.exec(
      'echo hello > out.txt && id -u && node --version && echo "FLAG=$OMNEXX"',
      {
        cwd: worktree,
        env: scrubEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-should-not-pass-0000000000' }),
        timeoutMs: 60_000,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(String(process.getuid?.() ?? ''));
    expect(r.output).toMatch(/v22\./);
    expect(r.output).toContain('FLAG=1');
    expect(r.output).not.toContain('sk-ant-should');
    expect(await readFile(join(worktree, 'out.txt'), 'utf8')).toBe('hello\n');
    expect((await stat(join(worktree, 'out.txt'))).uid).toBe(process.getuid?.());
  });

  it('cannot write outside its mounts or see the host home, and has no network in "none" mode', async () => {
    const { s, worktree } = await sandbox('none');
    const run = (c: string) => s.exec(c, { cwd: worktree, env: {}, timeoutMs: 60_000 });
    expect((await run('touch /etc/x')).exitCode).not.toBe(0);
    expect((await run('touch /usr/local/x')).exitCode).not.toBe(0);
    expect((await run(`ls ${process.env.HOME ?? '/home'}/.ssh`)).exitCode).not.toBe(0);
    expect(
      (
        await run(
          "node -e \"require('http').get('http://1.1.1.1', () => process.exit(0)).on('error', () => process.exit(7))\"",
        )
      ).exitCode,
    ).toBe(7);
    expect((await run('touch /tmp/scratch-ok')).exitCode).toBe(0);
  });

  it('a timeout kills the command inside the container, not just the docker client', async () => {
    const { s, worktree } = await sandbox();
    await mkdir(join(worktree, 'x'), { recursive: true });
    const r = await s.exec('sleep 300 & sleep 300', {
      cwd: worktree,
      env: {},
      timeoutMs: 1_500,
      killGraceMs: 500,
    });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 1_500));
    // The slim image has no `ps`: count through /proc so a missing tool can't make this pass.
    const ps = await s.exec(
      // Only the test's `sleep 300` processes count; the container's own `sleep infinity` stays.
      'n=0; for c in /proc/[0-9]*/cmdline; do [ "$(tr "\\0" " " < $c 2>/dev/null)" = "sleep 300 " ] && n=$((n+1)); done; echo $n',
      { cwd: worktree, env: {}, timeoutMs: 20_000 },
    );
    expect(ps.output.trim()).toBe('0');
  });
});

describe.skipIf(!available)('supervised run with sandbox = "docker"', () => {
  it('gates, checks and agent commands run in the container; the container is removed afterwards', async () => {
    const { startTestRun, makeRepo } = await import('../support/harness.js');
    const { fileTask, fileWorker, planner, scenario } = await import('../support/scenarios.js');
    const { ScriptedProvider } = await import('../support/scripted-provider.js');
    const { supervise } = await import('../../src/core/supervisor.js');
    const { readEvents } = await import('../../src/core/events.js');
    const { execa } = await import('execa');
    const plan = planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, fileWorker)),
      config: {
        sandbox: 'docker',
        docker: { image: 'node:22-bookworm-slim', network: 'none' },
        gates: [
          {
            name: 'test',
            run: 'node --test --test-reporter=tap && test -f /.dockerenv',
            parser: 'node-test',
            level: 'must-pass',
          },
        ],
      },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
    });
    expect(out.status).toBe('finished');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.find((e) => e.type === 'sandbox.start')).toMatchObject({
      image: 'node:22-bookworm-slim',
      network: 'none',
    });
    const left = await execa('docker', [
      'ps',
      '-a',
      '--filter',
      `name=omnexx-${t.run.state.runId}`,
      '-q',
    ]);
    expect(left.stdout.trim()).toBe('');
  });
});

describe('docker availability probe', () => {
  it('returns a boolean without throwing', () => {
    expect(typeof available).toBe('boolean');
  });
});
