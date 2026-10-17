import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveChat, type ChatState } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import { makeRepo } from '../support/harness.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { jsonPipes } from '../support/chat-pipes.js';
import { isolatedEnv } from '../support/tmp.js';

/** The main agent asks the "scout" card; the scout answers in one turn. */
const script: Script = ({ turn, request }) => {
  const isScout = request.system.some((b) => b.text.includes('"scout" agent'));
  if (isScout) return say('Found three source files.');
  return turn === 0
    ? call('agent', { name: 'scout', message: 'List the source files.' })
    : say('The scout found three files.');
};

describe('chat-server: helpers (subagents) in the panel state', () => {
  it('shows a helper working, then done with its turns, for the current message', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, '.omnexx', 'agents'), { recursive: true });
    await writeFile(
      join(repo, '.omnexx', 'agents', 'scout.md'),
      '---\nname: scout\ndescription: Finds files.\n---\nYou look around the repo and report.\n',
    );
    const { stdin, stdout, out } = jsonPipes();
    const provider = new ScriptedProvider(script);
    const io: CliIO = {
      stdout,
      stderr: new PassThrough(),
      stdin,
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
      fetch: () => Promise.reject(new Error('no network in tests')),
    };
    const done = serveChat(io, () => Promise.resolve(0), { version: '0' });
    const states = (): ChatState[] =>
      out.filter((o) => o.type === 'state') as unknown as ChatState[];
    const until = async <T>(fn: () => T | undefined, what: string): Promise<T> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const v = fn();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    stdin.write(`${JSON.stringify({ type: 'send', text: 'what files are there?' })}\n`);
    const finished = await until(
      () => states().find((s) => s.helpers.some((h) => h.status === 'done')),
      'a finished helper',
    );
    const scout = finished.helpers[0];
    expect(scout).toMatchObject({ agent: 'scout', status: 'done', id: 1 });
    expect(scout?.turns).toBeGreaterThanOrEqual(1);
    expect(scout?.description).toMatch(/List the source files/);
    expect(states().every((s) => s.browser === null)).toBe(true);

    // A new chat clears them.
    stdin.write(`${JSON.stringify({ type: 'clear' })}\n`);
    await until(
      () => (states().at(-1)?.helpers.length === 0 ? true : undefined),
      'cleared helpers',
    );
    stdin.end();
    expect(await done).toBe(0);
  });
});
