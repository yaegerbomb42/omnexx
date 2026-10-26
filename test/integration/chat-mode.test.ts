import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { Session } from '../../src/tui/session.js';
import { makeRepo } from '../support/harness.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { isolatedEnv, tempDir } from '../support/tmp.js';

/** First message: edit, then try two guarded actions, then answer. Second: recall the first. */
function script(outside: string): Script {
  return ({ turn, request }) => {
    const users = request.messages.filter(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'text'),
    ).length;
    if (users === 2)
      return say(`second message; I remember ${String(request.messages.length)} messages`);
    return (
      [
        call('write_file', { path: 'src/hello.js', content: 'export const hi = () => "hi";\n' }),
        call('write_file', { path: outside, content: 'outside\n' }),
        call('bash', { command: 'sudo ls' }),
        say('Added src/hello.js.'),
      ][turn] ?? say('done')
    );
  };
}

describe('chat mode', () => {
  it('codes in the checkout, asks before going past a guard, runs the checks, and remembers', async () => {
    const repo = await makeRepo();
    await writeFile(
      join(repo, 'omnexx.toml'),
      '[[gates]]\nname = "test"\nrun = "node --test"\nparser = "generic"\n',
    );
    const outside = join(await tempDir(), 'note.txt');
    const provider = new ScriptedProvider(script(outside));
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
    };
    const s = new Session(io, () => Promise.resolve(0));
    await s.submit('/chat');
    expect(s.mode).toBe('chat');

    const answers = ['y', 'n'];
    const asked: string[] = [];
    s.onChange(() => {
      if (s.pending && !asked.includes(s.pending.question)) {
        asked.push(s.pending.question);
        void s.submit(answers.shift() ?? 'n');
      }
    });
    await s.submit('add a hello module');

    expect(await readFile(join(repo, 'src/hello.js'), 'utf8')).toContain('hi');
    expect(asked[0]).toMatch(/outside the repo/);
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
    expect(asked[1]).toMatch(/sudo ls/);
    const text = s.entries.map((e) => e.text).join('\n');
    expect(text).toContain('Added src/hello.js.');
    expect(text).toMatch(/checks\s+test ✓/);
    expect(text).toMatch(/refused: run `sudo ls`/);

    await s.submit('and now?');
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(
      /second message; I remember 9 messages/,
    );
  });
});

describe('/compact (the panel Compact button)', () => {
  it('says there is nothing to compact in a one-exchange chat, and compacts a longer one', async () => {
    const repo = await makeRepo();
    const provider = new ScriptedProvider(({ request }) =>
      request.system.some((b) => b.text.startsWith('You compress a coding conversation'))
        ? say('Earlier: the user asked twice about the repo.')
        : say(`answer ${'x'.repeat(4_000)}`),
    );
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
    };
    const s = new Session(io, () => Promise.resolve(0));
    await s.submit('/chat');
    await s.submit('first question');
    await s.submit('/compact');
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(/nothing to compact yet/);
    await s.submit('second question');
    await s.submit('third question');
    await s.submit('/compact');
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(
      /compacted: [\d.]+k? → [\d.]+k? tokens/,
    );
  }, 60_000);
});

describe('chat runs out of room', () => {
  it('summarizes and keeps going instead of stopping at max_tokens_per_cycle', async () => {
    const repo = await makeRepo();
    // The summarize-and-continue backstop this test exercises relies on the prompt
    // growing until the token cap trips; rolling memory caps it by design.
    await writeFile(
      join(repo, 'omnexx.toml'),
      '[budget]\nmax_tokens_per_cycle = 40000\n[context]\nmemory = "full"\n',
    );
    const provider = new ScriptedProvider(({ request, turn }) => {
      if (request.system.some((b) => b.text.startsWith('You compress a coding conversation')))
        return say('Read README.md several times; nothing changed yet.');
      const first = request.messages.find((m) => m.role === 'user')?.content[0];
      const continuing =
        first?.type === 'text' && first.text.startsWith('Summary of the work so far');
      return continuing
        ? say('finished after continuing')
        : call('search', { pattern: `term${String(turn)}` });
    });
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
    };
    const s = new Session(io, () => Promise.resolve(0));
    await s.submit('/chat');
    await s.submit('look around the repo');
    const text = s.entries.map((e) => e.text).join('\n');
    expect(text).toMatch(/context was full: summarized the work so far and kept going/);
    expect(text).toContain('finished after continuing');
    expect(text).not.toMatch(/\(stopped: max_tokens_per_cycle\)/);
  }, 60_000);
});

describe('stop, pause and new messages act at once', () => {
  async function chatWithSlowCommand() {
    const repo = await makeRepo();
    const provider = new ScriptedProvider(({ request }) => {
      const asks = request.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n');
      if (asks.includes('switch to this')) return say('switched right away');
      if (asks.includes('Continue where you left off')) return say('carried on after resume');
      return request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
        ? say('the slow command finished')
        : call('bash', { command: 'sleep 30' });
    });
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
    };
    const s = new Session(io, () => Promise.resolve(0));
    await s.submit('/chat');
    return s;
  }
  const started = (s: Session) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (s.entries.some((e) => e.text.includes('sleep 30'))) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });

  it('stop kills a running command right away', async () => {
    const s = await chatWithSlowCommand();
    const t0 = Date.now();
    const work = s.submit('run the slow thing');
    await started(s);
    await s.submit('/stop');
    await work;
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 40_000);

  it('a new message cuts the current step short and is answered right away', async () => {
    const s = await chatWithSlowCommand();
    const t0 = Date.now();
    const work = s.submit('run the slow thing');
    await started(s);
    await s.submit('switch to this');
    await work;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(s.entries.map((e) => e.text).join('\n')).toContain('switched right away');
  }, 40_000);

  it('pause holds at once and resume carries on', async () => {
    const s = await chatWithSlowCommand();
    const t0 = Date.now();
    const work = s.submit('run the slow thing');
    await started(s);
    await s.submit('/pause');
    await work;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(/paused/);
    await s.submit('/resume');
    expect(s.entries.map((e) => e.text).join('\n')).toContain('carried on after resume');
  }, 40_000);
});

describe('which model are you', () => {
  it('tells the model its real name, so it does not guess another', async () => {
    const repo = await makeRepo();
    const provider = new ScriptedProvider(() => say('ok'));
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
    };
    const s = new Session(io, () => Promise.resolve(0));
    await s.submit('/chat');
    await s.submit('which model are you?');
    const system = provider.requests[0]?.system.map((b) => b.text).join('\n') ?? '';
    expect(system).toMatch(/running on the model \S+:\S+ \(provider:model\)/);
    expect(system).toMatch(/don't guess another name/);
  });
});
