import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import { git } from '../../src/git/git.js';
import type { NotifyPayload } from '../../src/notify/ntfy.js';
import { WebhookNotifier } from '../../src/notify/webhook.js';
import { Redactor } from '../../src/security/redact.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { ScriptedProvider } from '../support/scripted-provider.js';
import { tempDir } from '../support/tmp.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};
const PATH0 = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH0;
});

/** A stand-in `gh` that logs its arguments and stdin, and "creates" PR #7. */
async function fakeGh(): Promise<string> {
  const bin = await tempDir();
  const log = join(bin, 'gh.log');
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1 $2" = "pr view" ]; then exit 1; fi\ncat > "${log}.body"\necho "https://github.com/me/app/pull/7"\n`,
  );
  await chmod(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${PATH0 ?? ''}`;
  return log;
}

describe('[git] open_pr and webhook notifications', () => {
  it('pushes the branch and opens one PR with the report as its body', async () => {
    const log = await fakeGh();
    const remote = await tempDir();
    await git(remote, ['init', '-q', '--bare']);
    const repo = await makeRepo();
    await git(repo, ['remote', 'add', 'origin', remote]);
    const provider = new ScriptedProvider(
      scenario(planner([{ id: 'M1', title: 'Files', tasks: [fileTask('M1.T01')] }]), fileWorker),
    );
    const pushes: NotifyPayload[] = [];
    const t = await startTestRun({
      repo,
      provider,
      goal: 'Create the first file',
      config: { gates: [GATE], git: { open_pr: true } },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
      pausePollMs: 10,
      notifier: {
        notify: (p) => {
          pushes.push(p);
          return Promise.resolve();
        },
      },
    });
    expect(out.status).toBe('finished');
    const state = await t.run.store.readState();
    expect(state.prUrl).toBe('https://github.com/me/app/pull/7');
    expect((await git(remote, ['branch', '--list', state.branch])).stdout).toContain(state.branch);
    const calls = await readFile(log, 'utf8');
    expect(calls).toMatch(
      /pr create --head omnexx\/\S+ --base main --title omnexx: Create the first file --body-file -/,
    );
    expect(await readFile(`${log}.body`, 'utf8')).toMatch(
      /# Omnexx report[\s\S]*Opened by omnexx run/,
    );
    expect(pushes.find((p) => p.kind === 'finished')?.url).toBe('https://github.com/me/app/pull/7');
    expect((await readEvents(t.run.store.eventsPath)).some((e) => e.type === 'pr.opened')).toBe(
      true,
    );
  });

  it('posts Slack/Discord-compatible webhooks for the chosen events, never throwing', async () => {
    const posted: string[] = [];
    const results: boolean[] = [];
    const fetchFn: typeof fetch = (_u, init) => {
      posted.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response('ok'));
    };
    const n = new WebhookNotifier(
      { url_env: 'HOOK', events: ['finished'], timeout_ms: 1_000 },
      { HOOK: 'https://hooks.example/x' },
      new Redactor([]),
      fetchFn,
      (ok) => results.push(ok),
    );
    await n.notify({ kind: 'started', runId: 'r1', repo: 'app' });
    await n.notify({
      kind: 'finished',
      runId: 'r1',
      repo: 'app',
      commits: 3,
      url: 'https://github.com/me/app/pull/7',
    });
    expect(posted).toHaveLength(1);
    const body = JSON.parse(posted[0] ?? '{}') as { text: string; content: string };
    expect(body.text).toMatch(/app · r1[\s\S]*3 commits[\s\S]*pull\/7/);
    expect(body.content).toBe(body.text);
    const off = new WebhookNotifier(
      { url_env: 'MISSING', events: ['finished'], timeout_ms: 1_000 },
      {},
      new Redactor([]),
      fetchFn,
      (ok) => results.push(ok),
    );
    await off.notify({ kind: 'finished', runId: 'r1', repo: 'app' });
    expect(results).toEqual([true, false]);
  });
});
