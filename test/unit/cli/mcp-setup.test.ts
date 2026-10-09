import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/mcp.js';
import type { CliIO } from '../../../src/cli/io.js';
import { readSecrets } from '../../../src/integrations/secrets.js';
import { tempDir } from '../../support/tmp.js';
import { GITHUB, PLAYWRIGHT } from '../../support/registry-fixtures.js';

async function setup() {
  const base = await tempDir('omnexx-mcp-setup-');
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, 'home'),
    OMNEXX_HOME: join(base, 'state'),
    OMNEXX_CONFIG_HOME: join(base, 'config'),
  };
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await mkdir(env.OMNEXX_CONFIG_HOME, { recursive: true });
  const configFile = join(env.OMNEXX_CONFIG_HOME, 'config.toml');
  await writeFile(configFile, '# my comments survive\n[policy]\nauto_approve = true # yes\n');
  return { env, repo, configFile, home: env.HOME };
}

async function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv, servers: unknown[] = []) {
  let out = '';
  let err = '';
  let code = 0;
  const io: CliIO = {
    stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    cwd,
    isTTY: false,
    env,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ servers: servers.map((server) => ({ server })) })),
      ),
  };
  const program = new Command().exitOverride();
  register(program, io, (c) => (code = c));
  await program.parseAsync(['node', 'omnexx', ...args]);
  return { out, err, code };
}

describe('omnexx mcp: easy setup', () => {
  it('adds a registry server by name, confirming first, and keeps the config’s comments', async () => {
    const { env, repo, configFile } = await setup();
    const preview = await cli(['mcp', 'add', 'playwright'], repo, env, [PLAYWRIGHT]);
    expect(preview.out).toContain('io.github.microsoft/playwright-mcp');
    expect(preview.out).toContain('✓ known publisher');
    expect(preview.out).toContain('npx -y @playwright/mcp@0.0.82');
    expect(preview.out).toContain('Re-run with --yes');
    expect(await readFile(configFile, 'utf8')).not.toContain('playwright');

    const done = await cli(['mcp', 'add', 'playwright', '--yes'], repo, env, [PLAYWRIGHT]);
    expect(done.out).toContain('Added MCP server "playwright-mcp"');
    const text = await readFile(configFile, 'utf8');
    expect(text).toContain('# my comments survive');
    expect(text).toContain('auto_approve = true # yes');
    expect(text).toContain('[mcp.servers.playwright-mcp]');

    expect((await cli(['mcp', 'remove', 'playwright-mcp'], repo, env)).out).toContain('Removed');
    expect(await readFile(configFile, 'utf8')).toContain('# my comments survive');
  });

  it('stores a required token as a secret, never in config.toml, and refuses without it', async () => {
    const { env, repo, configFile } = await setup();
    const missing = await cli(['mcp', 'add', 'github', '--yes'], repo, env, [GITHUB]);
    expect(missing.err).toMatch(/Authorization is required/);
    expect(missing.code).toBe(1);

    const ok = await cli(
      ['mcp', 'add', 'github', '--yes', '--set', 'Authorization=ghp_x'],
      repo,
      env,
      [GITHUB],
    );
    expect(ok.out).toContain('Added MCP server "github-mcp-server"');
    const text = await readFile(configFile, 'utf8');
    expect(text).toContain('Authorization = "secret:Authorization"');
    expect(text).not.toContain('ghp_x');
    expect(await readSecrets(env.OMNEXX_CONFIG_HOME)).toEqual({
      'github-mcp-server': { Authorization: 'Bearer ghp_x' },
    });
  });

  it('says what it found when the name is unknown, and searches with ✓ marks', async () => {
    const { env, repo } = await setup();
    const none = await cli(['mcp', 'add', 'zzz'], repo, env, []);
    expect(none.err).toMatch(/Nothing called "zzz"/);
    const found = await cli(['mcp', 'search', 'github'], repo, env, [GITHUB]);
    expect(found.out).toMatch(/✓ io\.github\.github\/github-mcp-server\s+remote/);
  });

  it('imports Claude Code servers with their secrets moved to the secrets file', async () => {
    const { env, repo, configFile, home } = await setup();
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          world: { type: 'stdio', command: 'node', args: ['w.js'], env: { KEY: 'raw-secret' } },
        },
      }),
    );
    const preview = await cli(['mcp', 'import'], repo, env);
    expect(preview.out).toMatch(/\+ world\s+Claude Code/);
    const done = await cli(['mcp', 'import', '--yes'], repo, env);
    expect(done.out).toContain('Imported world');
    const text = await readFile(configFile, 'utf8');
    expect(text).toContain('KEY = "secret:KEY"');
    expect(text).not.toContain('raw-secret');
    expect(await readSecrets(env.OMNEXX_CONFIG_HOME)).toEqual({ world: { KEY: 'raw-secret' } });
    expect((await cli(['mcp', 'import'], repo, env)).out).toContain('already set up');
  });
});
