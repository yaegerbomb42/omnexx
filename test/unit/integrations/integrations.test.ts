import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { McpClientManager } from '../../../src/mcp/client-manager.js';
import { findOtherToolServers, serversFrom } from '../../../src/integrations/importers.js';
import {
  isTrusted,
  planInstall,
  searchRegistry,
  type RegistryServer,
} from '../../../src/integrations/registry.js';
import { readSecrets, secretsFile, writeServerSecrets } from '../../../src/integrations/secrets.js';
import { removeTable, setTable } from '../../../src/integrations/toml-edit.js';
import { tempDir } from '../../support/tmp.js';
import { GITHUB } from '../../support/registry-fixtures.js';

const LOOKALIKE: RegistryServer = {
  name: 'io.github.crypto-ninja/github-mcp-server',
  packages: [
    { registryType: 'npm', identifier: 'gh-mcp', version: '1.0.0', transport: { type: 'stdio' } },
  ],
};

describe('toml-edit', () => {
  const RAW = `# my config\n[models]\n# chat model\nchat = "a:b"\n\n[mcp.servers.old]\ncommand = "x"\n\n[mcp.servers.old.extra]\nk = "v"\n\n[policy]\nauto_approve = true # keep me\n`;

  it('adds a table at the end and keeps every comment', () => {
    const out = setTable(RAW, ['mcp', 'servers', 'new-one'], {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.82'],
      env: { TOKEN: 'secret:TOKEN' },
      url: undefined,
    });
    expect(out).toContain('# my config');
    expect(out).toContain('# chat model');
    expect(out).toContain('auto_approve = true # keep me');
    const parsed = parse(out) as { mcp: { servers: Record<string, unknown> } };
    expect(parsed.mcp.servers['new-one']).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.82'],
      env: { TOKEN: 'secret:TOKEN' },
    });
  });

  it('removes a table with its sub-tables, and replaces in place of a re-add', () => {
    const { text, removed } = removeTable(RAW, ['mcp', 'servers', 'old']);
    expect(removed).toBe(true);
    expect(text).not.toContain('old');
    expect(text).toContain('auto_approve = true # keep me');
    expect(removeTable(RAW, ['mcp', 'servers', 'nope']).removed).toBe(false);
    const twice = setTable(setTable('', ['t'], { a: 1 }), ['t'], { a: 2 });
    expect(parse(twice)).toEqual({ t: { a: 2 } });
  });

  it('quotes keys that need it and refuses to write broken TOML', () => {
    expect(parse(setTable('', ['mcp', 'servers', 'a.b'], { x: true }))).toEqual({
      mcp: { servers: { 'a.b': { x: true } } },
    });
    expect(() => setTable('[broken', ['t'], { a: 1 })).toThrow();
  });
});

describe('registry', () => {
  it('runs an npm package with npx, pinned', async () => {
    const { PLAYWRIGHT } = await import('../../support/registry-fixtures.js');
    expect(planInstall(PLAYWRIGHT)).toMatchObject({
      name: 'playwright-mcp',
      via: 'npm',
      config: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.82'] },
      needs: [],
    });
  });

  it('prefers a remote endpoint over docker, and asks for its secret header', () => {
    const plan = planInstall(GITHUB);
    expect(plan).toMatchObject({
      via: 'remote',
      config: {
        url: 'https://api.githubcopilot.com/mcp/',
        headers_env: { Authorization: 'secret:Authorization' },
      },
    });
    expect(plan?.needs).toEqual([
      {
        key: 'Authorization',
        description: 'PAT',
        secret: true,
        required: true,
        target: 'header',
      },
    ]);
    const dockerOnly = planInstall({ ...GITHUB, remotes: null });
    expect(dockerOnly?.config.command).toBe('docker');
    expect(planInstall({ name: 'x/y' })).toBeUndefined();
  });

  it('ranks known publishers above look-alikes and drops inactive or repeated entries', async () => {
    const body = {
      servers: [
        { server: LOOKALIKE },
        { server: GITHUB },
        {
          server: { name: 'io.github.someone/github-old' },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } },
        },
        { server: GITHUB },
      ],
    };
    const seen: string[] = [];
    const fetchFn = ((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response(JSON.stringify(body)));
    }) as unknown as typeof fetch;
    const hits = await searchRegistry('github-mcp-server', { fetchFn });
    expect(hits.map((h) => [h.name, h.trusted])).toEqual([
      ['io.github.github/github-mcp-server', true],
      ['io.github.crypto-ninja/github-mcp-server', false],
    ]);
    expect(seen[0]).toContain('version=latest');
    expect(isTrusted('io.github.microsoft/playwright-mcp')).toBe(true);
    const failing = (() =>
      Promise.resolve(new Response('', { status: 503 }))) as unknown as typeof fetch;
    await expect(searchRegistry('x', { fetchFn: failing })).rejects.toThrow(/503/);
    // A cached search answers without the network, until it is a day old.
    const cacheFile = join(await tempDir('omnexx-regcache-'), 'c.json');
    await searchRegistry('github-mcp-server', { fetchFn, cacheFile, now: 1_000 });
    const calls = seen.length;
    expect(
      await searchRegistry('github-mcp-server', { fetchFn: failing, cacheFile, now: 2_000 }),
    ).toHaveLength(2);
    expect(seen.length).toBe(calls);
    await expect(
      searchRegistry('github-mcp-server', {
        fetchFn: failing,
        cacheFile,
        now: 1_000 + 25 * 3_600_000,
      }),
    ).rejects.toThrow(/503/);
  });
});

describe('importers', () => {
  it('reads Claude Code (user and this project), Claude Desktop-style and Cursor configs', async () => {
    const home = await tempDir('omnexx-import-');
    const repo = join(home, 'repo');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { world: { type: 'stdio', command: 'node', args: ['w.js'], env: { K: 'v' } } },
        projects: {
          [repo]: {
            mcpServers: {
              local: { type: 'http', url: 'http://x/mcp', headers: { Authorization: 'Bearer t' } },
            },
          },
        },
      }),
    );
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { world: { command: 'dup' }, cur: { command: 'uvx', args: ['a'] } },
      }),
    );
    const found = await findOtherToolServers({ HOME: home }, repo);
    expect(found.map((s) => [s.name, s.source])).toEqual([
      ['local', 'Claude Code (this project)'],
      ['world', 'Claude Code'],
      ['cur', 'Cursor'],
    ]);
    expect(found[0]?.headers).toEqual({ Authorization: 'Bearer t' });
    expect(serversFrom({ bad: 1, none: {} }, 'Cursor')).toEqual([]);
  });
});

describe('secrets and the server environment', () => {
  it('keeps secrets in a 0600 file and drops a server’s entry on remove', async () => {
    const home = await tempDir('omnexx-secrets-');
    await writeServerSecrets(home, 'gh', { Authorization: 'Bearer t' });
    await writeServerSecrets(home, 'gh', { OTHER: 'x' });
    expect(await readSecrets(home)).toEqual({ gh: { Authorization: 'Bearer t', OTHER: 'x' } });
    expect((await stat(secretsFile(home))).mode & 0o777).toBe(0o600);
    await writeServerSecrets(home, 'gh', {});
    expect(JSON.parse(await readFile(secretsFile(home), 'utf8'))).toEqual({});
  });

  it('gives a stdio server only a small base env plus what its config names', () => {
    const env = {
      PATH: '/bin',
      HOME: '/h',
      npm_config_cache: '/c',
      OPENAI_API_KEY: 'sk-leak',
      GH: 'from-env',
    };
    const mgr = new McpClientManager({}, { env, secrets: { s: { TOKEN: 'stored' } } });
    const base = {
      command: 'x',
      args: [],
      headers_env: {},
      allow_tools: ['*'],
      timeout: '30s',
      inherit_env: false,
    };
    expect(
      mgr.serverEnv('s', { ...base, env: { TOKEN: 'secret:TOKEN', A: 'GH', B: 'literal' } }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
      npm_config_cache: '/c',
      TOKEN: 'stored',
      A: 'from-env',
      B: 'literal',
    });
    expect(mgr.serverEnv('s', { ...base, env: [], inherit_env: true })).toHaveProperty(
      'OPENAI_API_KEY',
    );
  });
});
