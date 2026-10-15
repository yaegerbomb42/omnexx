import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpClientManager } from '../../../src/mcp/client-manager.js';
import {
  addCommand,
  addFromGallery,
  configuredServers,
  importServers,
  listServers,
  removeServer,
  setAllowTools,
  setEnabled,
  splitCommand,
  type McpPlace,
} from '../../../src/mcp/manage.js';
import { readSecrets } from '../../../src/integrations/secrets.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const fakeServer = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/mcp/fake-server.ts',
);
const FAKE = [process.execPath, '--experimental-strip-types', fakeServer];

async function place(): Promise<McpPlace> {
  return { cwd: await tempDir('omnexx-mcp-repo-'), env: await isolatedEnv() };
}

const configText = (p: McpPlace) =>
  readFile(join(p.env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'), 'utf8');

describe('MCP server management', () => {
  it('adds a command, starts it, and reports its tools and their token cost', async () => {
    const p = await place();

    const r = await addCommand(p, 'demo', FAKE);

    expect(r.probe?.state).toBe('running');
    expect(r.probe?.tools.map((t) => t.name)).toContain('echo');
    const [v] = await listServers(p, { probe: true });
    expect(v).toMatchObject({ name: 'demo', state: 'running', origin: 'user', kind: 'stdio' });
    expect(v?.toolCount).toBeGreaterThan(0);
    expect(v?.tokens).toBeGreaterThan(10);
  });

  it('a server that fails to start says why, with the tail of its stderr', async () => {
    const p = await place();
    const crash = `console.error("boom: missing API_KEY"); process.exit(3)`;

    const r = await addCommand(p, 'broken', [process.execPath, '-e', crash]);

    expect(r.probe?.state).toBe('failed');
    expect(r.probe?.error).toContain('MCP server "broken" failed to start');
    expect(r.probe?.error).toContain('boom: missing API_KEY');
    expect(r.probe?.log).toContain('exited with code 3');
  });

  it('a missing command gets an install hint', async () => {
    const p = await place();

    const r = await addCommand(p, 'nope', 'omnexx-no-such-binary-xyz --flag');

    expect(r.probe?.error).toContain('"omnexx-no-such-binary-xyz" was not found on PATH');
  });

  it('env values given at add time go to the secrets file, not config.toml', async () => {
    const p = await place();

    await addCommand(p, 'demo', FAKE, { API_KEY: 'sk-secret' }, { check: false });

    const text = await configText(p);
    expect(text).toContain('API_KEY = "secret:API_KEY"');
    expect(text).not.toContain('sk-secret');
    expect((await readSecrets(p.env.OMNEXX_CONFIG_HOME ?? '')).demo).toEqual({
      API_KEY: 'sk-secret',
    });
  });

  it('disable keeps the setup but the server is never started; enable brings it back', async () => {
    const p = await place();
    await addCommand(p, 'demo', FAKE, {}, { check: false });

    await setEnabled(p, 'demo', false);

    const [off] = await listServers(p, { probe: true });
    expect(off?.state).toBe('disabled');
    const mgr = new McpClientManager(await configuredServers(p), { env: p.env });
    expect(await mgr.listTools()).toEqual([]);
    await mgr.closeAll();
    await setEnabled(p, 'demo', true);
    expect(await configText(p)).not.toContain('enabled');
  });

  it('the tool allow-list hides the other tools and lowers the token cost', async () => {
    const p = await place();
    await addCommand(p, 'demo', FAKE, {}, { check: false });
    const [before] = await listServers(p, { probe: true });

    await setAllowTools(p, 'demo', ['echo']);

    const [after] = await listServers(p, { probe: true });
    expect(after?.toolCount).toBe(1);
    expect(after?.tokens).toBeLessThan(before?.tokens ?? 0);
    expect(after?.tools.find((t) => t.name !== 'echo')?.allowed).toBe(false);
    await setAllowTools(p, 'demo', []);
    expect(await configText(p)).not.toContain('allow_tools');
  });

  it('removes a server and its secrets; a project server must be removed where it lives', async () => {
    const p = await place();
    await addCommand(p, 'demo', FAKE, { K: 'v' }, { check: false });
    await writeFile(
      join(p.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['x.js'] } } }),
    );

    await removeServer(p, 'demo');

    expect(Object.keys(await configuredServers(p))).toEqual(['shared']);
    expect(await readSecrets(p.env.OMNEXX_CONFIG_HOME ?? '')).toEqual({});
    await expect(removeServer(p, 'shared')).rejects.toThrow(/omnexx.toml or .mcp.json/);
  });

  it('disabling a project server writes a user override that keeps its command', async () => {
    const p = await place();
    await mkdir(p.cwd, { recursive: true });
    await writeFile(
      join(p.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['x.js'] } } }),
    );

    await setEnabled(p, 'shared', false);

    const [v] = await listServers(p);
    expect(v).toMatchObject({ name: 'shared', state: 'disabled', target: 'node x.js' });
  });

  it('adds from the gallery with an argument filled in and a bearer token stored as a secret', async () => {
    const p = await place();

    await addFromGallery(p, 'filesystem', { FOLDER: '/tmp/x' }, { check: false });
    await addFromGallery(p, 'github', { Authorization: 'ghp_abc' }, { check: false });

    const text = await configText(p);
    expect(text).toContain('"@modelcontextprotocol/server-filesystem", "/tmp/x"');
    expect(text).toContain('Authorization = "secret:Authorization"');
    expect((await readSecrets(p.env.OMNEXX_CONFIG_HOME ?? '')).github).toEqual({
      Authorization: 'Bearer ghp_abc',
    });
    await expect(addFromGallery(p, 'postgres', {}, { check: false })).rejects.toThrow(
      /needs DATABASE_URL/,
    );
  });

  it('imports found servers with their env and headers as secrets', async () => {
    const p = await place();

    const added = await importServers(p, [
      {
        name: 'remote',
        source: 'Pasted',
        args: [],
        env: {},
        url: 'https://example.invalid/mcp',
        headers: { Authorization: 'Bearer t' },
      },
    ]);

    expect(added).toEqual(['remote']);
    expect(await configText(p)).toContain('Authorization = "secret:header:Authorization"');
  });

  it('rejects names that would break the config', async () => {
    const p = await place();
    await expect(addCommand(p, 'bad name!', 'node x', {}, { check: false })).rejects.toThrow(
      /not a usable server name/,
    );
  });
});

describe('splitCommand', () => {
  it('splits like a shell for simple quoting', () => {
    expect(splitCommand(`npx -y "@scope/pkg" --dir 'My Files' a\\ b ""`)).toEqual([
      'npx',
      '-y',
      '@scope/pkg',
      '--dir',
      'My Files',
      'a b',
      '',
    ]);
    expect(() => splitCommand('npx "oops')).toThrow(/unclosed quote/);
  });
});
