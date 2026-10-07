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
