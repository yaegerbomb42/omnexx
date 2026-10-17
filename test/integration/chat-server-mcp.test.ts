import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serveChat } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import { makeRepo } from '../support/harness.js';
import { PLAYWRIGHT } from '../support/registry-fixtures.js';
import { say, ScriptedProvider } from '../support/scripted-provider.js';
import { jsonPipes, type Out } from '../support/chat-pipes.js';
import { isolatedEnv } from '../support/tmp.js';

interface View {
  name: string;
  state: string;
  toolCount: number;
  tokens: number;
  error?: string;
}

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/fake-server.ts');
const FAKE_CMD = `"${process.execPath}" --experimental-strip-types "${fakeServer}"`;

/** The registry answers from a fixture; nothing reaches the network. */
const registryFetch = ((url: string) =>
  Promise.resolve(
    url.includes('registry.modelcontextprotocol.io')
      ? new Response(JSON.stringify({ servers: [{ server: PLAYWRIGHT }] }))
      : new Response('no network in tests', { status: 500 }),
  )) as typeof fetch;

async function start() {
  const repo = await makeRepo();
  const { stdin, stdout, out } = jsonPipes();
  const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
  const io: CliIO = {
    stdout,
    stderr: new PassThrough(),
    stdin,
    env,
    cwd: repo,
    isTTY: false,
    makeProvider: () => new ScriptedProvider(() => say('ok')),
    fetch: registryFetch,
  };
  const done = serveChat(io, () => Promise.resolve(0), { version: '9.9.9' });
  const send = (cmd: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify({ type: 'mcp', ...cmd })}\n`);
  };
  let seen = 0;
  /** The next message of this type after everything already waited for. */
  const next = async (type: string, test: (o: Out) => boolean = () => true): Promise<Out> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const i = out.findIndex((o, n) => n >= seen && o.type === type && test(o));
      if (i >= 0) {
        seen = i + 1;
        return out[i] as Out;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const settled = (): Promise<Out> => next('mcpServers', (o) => o.checking === false);
  await next('ready');
  return { env, send, next, settled, stdin, done };
}

const servers = (o: Out): View[] => o.servers as View[];

describe('chat-server: the VS Code MCP section', () => {
  it('lists, adds by command, toggles, filters tools, shows logs and removes', async () => {
    const t = await start();

    t.send({ op: 'list' });
    expect(servers(await t.settled())).toEqual([]);

    t.send({ op: 'add', via: 'command', name: 'demo', command: FAKE_CMD });
    const added = await t.next('mcpResult');
    expect(added).toMatchObject({ ok: true });
    expect(added.message).toMatch(/Added "demo": \d+ tools, ~\d+ tokens/);
    const [running] = servers(await t.settled());
    expect(running).toMatchObject({ name: 'demo', state: 'running' });

    t.send({ op: 'allow', name: 'demo', tools: ['echo'] });
    expect(await t.next('mcpResult')).toMatchObject({ ok: true, name: 'demo' });
    expect(servers(await t.settled())[0]?.toolCount).toBe(1);

    t.send({ op: 'enable', name: 'demo', on: false });
    await t.next('mcpResult');
    expect(servers(await t.settled())[0]?.state).toBe('disabled');

    t.send({ op: 'logs', name: 'demo' });
    expect(await t.next('mcpLogs')).toMatchObject({ name: 'demo' });

    t.send({ op: 'remove', name: 'demo' });
    expect(await t.next('mcpResult')).toMatchObject({ ok: true });
    expect(servers(await t.settled())).toEqual([]);
    t.stdin.end();
    await t.done;
  });

  it('reports a server that will not start with its stderr, and keeps it for fixing', async () => {
    const t = await start();
    const crash = `"${process.execPath}" -e "console.error('no TOKEN set'); process.exit(2)"`;

    t.send({ op: 'add', via: 'command', name: 'bad', command: crash });

    const r = await t.next('mcpResult');
    expect(r.message).toContain('did not start');
    expect(r.message).toContain('no TOKEN set');
    const [v] = servers(await t.settled());
    expect(v?.state).toBe('failed');
    expect(v?.error).toContain('no TOKEN set');
    t.stdin.end();
    await t.done;
  });

  it('sends the gallery, searches the registry, imports pasted JSON, and rejects bad input', async () => {
    const t = await start();

    t.send({ op: 'gallery' });
    const g = await t.next('mcpGallery');
    expect((g.entries as { id: string }[]).map((e) => e.id)).toContain('playwright');

    t.send({ op: 'search', query: 'playwright' });
    const reg = await t.next('mcpRegistry');
    expect(reg.hits).toEqual([
      expect.objectContaining({
        id: 'io.github.microsoft/playwright-mcp',
        trusted: true,
        runs: 'npx -y @playwright/mcp@0.0.82',
      }),
    ]);

    t.send({
      op: 'import',
      json: '{"mcpServers": {"remote": {"url": "http://127.0.0.1:9/mcp", "headers": {"X-Key": "abc"}}}}',
    });
    expect(await t.next('mcpResult')).toMatchObject({ ok: true });
    const config = await readFile(join(t.env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'), 'utf8');
    expect(config).toContain('X-Key = "secret:header:X-Key"');
    expect(config).not.toContain('abc');

    t.send({ op: 'import', json: '{ not json' });
    expect(await t.next('mcpResult')).toMatchObject({ ok: false });
    t.send({ op: 'nope' });
    expect((await t.next('error')).message).toMatch(/unknown mcp op/);
    t.stdin.end();
    await t.done;
  });
});
