import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { Session, type RunCli } from '../../../src/tui/session.js';
import { tempDir } from '../../support/tmp.js';

async function fakeRun(root: string, id: string, events: object[]): Promise<void> {
  const dir = join(root, 'runs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  await writeFile(join(dir, 'goal.md'), '# Goal\n\nbuild it\n');
}

async function setup(runCli?: RunCli) {
  const home = await tempDir();
  const io = {
    env: { OMNEXX_HOME: home, OMNEXX_CONFIG_HOME: join(home, 'cfg') },
    cwd: home,
    isTTY: false,
  } as unknown as CliIO;
  const calls: string[][] = [];
  const cli: RunCli =
    runCli ??
    ((argv, cio) => {
      calls.push([...argv]);
      cio.stdout.write(`ran ${argv.join(' ')}\n`);
      return Promise.resolve(0);
    });
  const s = new Session(io, cli, () => 10_000);
  return { s, io, calls, root: resolvePaths(io.env).home };
}

describe('Session', () => {
  it('routes slash commands to the CLI with output captured', async () => {
    const { s, calls } = await setup();
    await s.submit('/doctor --offline');
    await s.submit('/providers list');
    expect(calls).toEqual([
      ['doctor', '--offline'],
      ['providers', 'list'],
    ]);
    expect(s.entries.map((e) => `${e.kind}:${e.text}`)).toContain('out:ran doctor --offline');
    expect(s.entries[0]).toMatchObject({ kind: 'user', text: '/doctor --offline' });
  });

  it('starts a detached run from plain text and attaches to the printed run id', async () => {
    const cli: RunCli = (argv, io) => {
      expect(argv).toEqual(['run', '--detach', 'add a health endpoint']);
      io.stdout.write('r_1\n');
      return Promise.resolve(0);
    };
    const { s, root } = await setup(cli);
    s.mode = 'run';
    await fakeRun(root, 'r_1', [
      { ts: 1, runId: 'r_1', cycle: 1, type: 'commit', sha: 'abcdef1', task: 'M1.T01' },
    ]);
    await s.submit('add a health endpoint');
    expect(s.runId).toBe('r_1');
    expect(s.telemetry.commits).toBe(1);
    expect(s.entries.some((e) => e.kind === 'feed' && e.text.includes('commit'))).toBe(true);
  });

  it('steers a live run by appending to goal.md', async () => {
    const { s, root } = await setup();
    s.mode = 'run';
    await fakeRun(root, 'r_2', []);
    await s.attach('r_2');
    s.runAlive = true;
    await s.submit('focus on the API first');
    const goal = await readFile(join(root, 'runs', 'r_2', 'goal.md'), 'utf8');
    expect(goal).toMatch(/## Steering\n- 1970-01-01 00:00: focus on the API first\n$/);
    await s.submit('/steer and skip the admin UI');
    expect(await readFile(join(root, 'runs', 'r_2', 'goal.md'), 'utf8')).toMatch(
      /focus on the API first\n- .*: and skip the admin UI\n$/,
    );
  });

  it('passes the attached run id to run commands, and handles verbosity, help, quit and errors', async () => {
    const { s, root, calls } = await setup();
    await fakeRun(root, 'r_3', []);
    await s.attach('r_3');
    await s.submit('/stop --now');
    expect(calls.at(-1)).toEqual(['stop', 'r_3', '--now']);
    await s.submit('/verbose');
    expect(s.verbosity).toBe('verbose');
    await s.submit('/help');
    expect(s.entries.some((e) => e.text.includes('/steer'))).toBe(true);
    await s.submit('/logs -f');
    expect(s.entries.at(-1)).toMatchObject({ kind: 'err' });
    s.detach();
    expect(s.runId).toBeUndefined();
    await s.submit('/quit');
    expect(s.quit).toBe(true);
  });

  it('completes slash commands by prefix', async () => {
    const { s } = await setup();
    expect(s.complete('/st').map((c) => c.name)).toEqual(['stop']);
    expect(s.complete('/mo').map((c) => c.name)).toEqual(['model', 'models']);
    expect(s.complete('/stop now')).toEqual([]);
    expect(s.complete('hello')).toEqual([]);
  });
});

describe('@file completion', () => {
  it('lists repo files matching the @partial, prefix matches first', async () => {
    const { makeRepo } = await import('../../support/harness.js');
    const repo = await makeRepo({ 'src/math.js': 'x', 'test/math.test.js': 'y', 'README.md': 'z' });
    const s = new Session({ env: {}, cwd: repo, isTTY: false } as unknown as CliIO, () =>
      Promise.resolve(0),
    );
    expect(s.completeFile('fix @ma')).toEqual([]);
    await new Promise<void>((r) =>
      s.onChange(() => {
        r();
      }),
    );
    expect(s.completeFile('fix @src/m')).toEqual(['src/math.js']);
    expect(s.completeFile('fix @math')).toEqual(['src/math.js', 'test/math.test.js']);
    expect(s.completeFile('no at sign')).toEqual([]);
  });
});
