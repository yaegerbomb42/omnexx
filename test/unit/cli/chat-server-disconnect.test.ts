import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveChat } from '../../../src/cli/chat-server.js';
import type { CliIO } from '../../../src/cli/io.js';
import { makeRepo } from '../../support/harness.js';
import { isolatedEnv } from '../../support/tmp.js';
import { say, ScriptedProvider } from '../../support/scripted-provider.js';

describe('chat-server disconnect', () => {
  it('returns 0 when the client destroys stdout mid-session', async () => {
    const repo = await makeRepo();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buf = '';
    stdout.on('data', (c: Buffer) => {
      buf += c.toString();
    });
    const io: CliIO = {
      stdout,
      stderr: new PassThrough(),
      stdin,
      env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
      cwd: repo,
      isTTY: false,
      makeProvider: () => new ScriptedProvider(() => say('hi')),
      fetch: () => Promise.reject(new Error('no network in tests')),
    };
    const done = serveChat(io, () => Promise.resolve(0), { version: '0.0.0' });
    const readyBy = Date.now() + 10_000;
    while (!buf.includes('"type":"ready"') && Date.now() < readyBy) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(buf).toContain('"type":"ready"');
    stdout.destroy();
    stdin.write(`${JSON.stringify({ type: 'sync' })}\n`);
    stdin.end();
    await expect(done).resolves.toBe(0);
  }, 15_000);
});
