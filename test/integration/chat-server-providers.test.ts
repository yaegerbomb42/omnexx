import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveChat } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import { makeRepo } from '../support/harness.js';
import { jsonPipes, type Out } from '../support/chat-pipes.js';
import { isolatedEnv } from '../support/tmp.js';

/** The chat server on in-memory pipes, with a fake fetch that serves one model list. */
async function start() {
  const { stdin, stdout, out } = jsonPipes();
  const io: CliIO = {
    stdout,
    stderr: new PassThrough(),
    stdin,
    env: await isolatedEnv({}),
    cwd: await makeRepo(),
    isTTY: false,
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const key = new Headers(init?.headers).get('api-key');
      if (url === 'https://res1.openai.azure.com/openai/v1/models' && key === 'az')
        return Promise.resolve(Response.json({ data: [{ id: 'gpt-deploy' }] }));
      return Promise.resolve(new Response('{}', { status: 401 }));
    },
  };
  void serveChat(io, () => Promise.resolve(0), { version: '9.9.9' });
  const send = (cmd: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  const until = async (pred: (o: Out) => boolean, what: string): Promise<Out> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const hit = out.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { send, until, stdin };
}

describe('chat-server: provider gallery messages', () => {
  it('probes a templated provider and a bad custom endpoint, then adds one', async () => {
    const t = await start();
    await t.until((o) => o.type === 'ready', 'ready');

    t.send({ type: 'probeProvider', provider: 'azure', key: 'az', fields: { resource: 'res1' } });
    const good = await t.until((o) => o.type === 'providerProbe', 'probe');
    expect(good).toMatchObject({ ok: true, models: ['gpt-deploy'] });

    t.send({ type: 'probeProvider', url: 'https://x.example.com/v1', key: 'bad' });
    const bad = await t.until((o) => o.type === 'providerProbe' && o.ok === false, 'bad probe');
    expect(bad.detail).toMatch(/^401: key rejected/);

    t.send({ type: 'addProvider', provider: 'azure', key: 'az', fields: { resource: 'res1' } });
    const settings = await t.until(
      (o) =>
        o.type === 'settings' &&
        Array.isArray(o.connected) &&
        (o.connected as { name: string }[]).some((p) => p.name === 'azure'),
      'azure connected',
    );
    const catalog = settings.catalog as { name: string; fields?: unknown[] }[];
    expect(catalog.find((c) => c.name === 'bedrock')?.fields?.length).toBe(1);
    t.stdin.end();
  });
});
