import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveChat } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import { readAgentSettings } from '../../src/config/agent-settings.js';
import { resolvePaths } from '../../src/core/paths.js';
import { makeRepo } from '../support/harness.js';
import { say, ScriptedProvider } from '../support/scripted-provider.js';
import { isolatedEnv } from '../support/tmp.js';

type Out = { type: string } & Record<string, unknown>;

describe('chat-server agent settings (the VS Code "Agent" card)', () => {
  it('reads the defaults, saves the levels and the ask-at-start choice', async () => {
    const repo = await makeRepo();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: Out[] = [];
    let buf = '';
    stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) out.push(JSON.parse(l) as Out);
    });
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
    const io: CliIO = {
      stdout,
      stderr: new PassThrough(),
      stdin,
      env,
      cwd: repo,
      isTTY: false,
      makeProvider: () => new ScriptedProvider(() => say('ok')),
      fetch: () => Promise.reject(new Error('no network in tests')),
    };
    const done = serveChat(io, () => Promise.resolve(0), { version: '9.9.9' });
    const send = (cmd: Record<string, unknown>): void => {
      stdin.write(`${JSON.stringify(cmd)}\n`);
    };
    const until = async (fn: (o: Out) => boolean, what: string): Promise<Out> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const hit = out.find(fn);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until((o) => o.type === 'ready', 'ready');

    send({ type: 'agentSettings' });
    const first = await until((o) => o.type === 'agentSettings', 'settings');
    expect(first).toMatchObject({
      saved: false,
      askOnStart: true,
      levels: { taskEffort: 5, contextLevel: 6 },
      summary: 'effort 5/5 · ctx 96k · 2h',
    });
    expect((first.meta as { task: string[] }).task).toHaveLength(10);

    send({
      type: 'setAgentSettings',
      levels: { taskEffort: 8, turnEffort: 3, contextLevel: 4, time: '8h', maxTokens: 32_000 },
      askOnStart: false,
    });
    const saved = await until((o) => o.type === 'agentSettings' && o.saved === true, 'saved');
    expect(saved).toMatchObject({ askOnStart: false, summary: 'effort 8/3 · ctx 40k · 8h' });
    expect(await readAgentSettings(resolvePaths(env))).toEqual({
      levels: { taskEffort: 8, turnEffort: 3, contextLevel: 4, time: '8h', maxTokens: 32_000 },
      askOnStart: false,
    });

    send({ type: 'setAgentSettings' });
    await until(
      (o) => o.type === 'error' && String(o.message).includes('levels'),
      'error for missing levels',
    );
    stdin.end();
    expect(await done).toBe(0);
  });
});
