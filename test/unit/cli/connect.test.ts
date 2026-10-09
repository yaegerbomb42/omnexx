import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/connect.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { CliIO } from '../../../src/cli/io.js';
import {
  CONNECTORS,
  connectorServer,
  findConnector,
} from '../../../src/integrations/connectors.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

function need(id: string) {
  const c = findConnector(id);
  if (!c) throw new Error(`no connector ${id}`);
  return c;
}

const home = (env: NodeJS.ProcessEnv): string => env.OMNEXX_CONFIG_HOME ?? '';

async function cli(args: string[]) {
  const env = await isolatedEnv();
  const cwd = await tempDir();
  let out = '';
  let err = '';
  let code: number = EXIT.ok;
  const sink = (f: (s: string) => void) =>
    ({
      write: (s: string) => {
        f(s);
        return true;
      },
    }) as unknown as NodeJS.WriteStream;
  const io: CliIO = {
    stdout: sink((s) => (out += s)),
    stderr: sink((s) => (err += s)),
    stdin: process.stdin,
    cwd,
    isTTY: false,
    env,
  };
  const run = async (argv: string[]) => {
    const program = new Command().exitOverride();
    register(program, io, (c) => {
      code = c;
    });
    await program.parseAsync(['node', 'omnexx', ...argv]);
    return { out, err, code };
  };
  return { env, run, first: await run(args) };
}

describe('connector catalog', () => {
  it('has unique ids, https URLs for remote servers, and at least 20 apps', () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const c of CONNECTORS) {
      expect(Boolean(c.url) !== Boolean(c.command)).toBe(true);
      if (c.url) expect(c.url).toMatch(/^https:\/\//);
      if (c.auth === 'token') expect(c.needs?.length).toBeGreaterThan(0);
    }
  });

  it('references secrets by name and never inlines them', () => {
    const gh = connectorServer(need('github'));
    expect(gh.headers_env).toEqual({ Authorization: 'secret:Authorization' });
    const gmail = connectorServer(need('GMAIL'));
    expect(gmail.env).toEqual({
      OAUTHLIB_INSECURE_TRANSPORT: '1',
      GOOGLE_OAUTH_CLIENT_ID: 'secret:GOOGLE_OAUTH_CLIENT_ID',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret:GOOGLE_OAUTH_CLIENT_SECRET',
    });
    expect(connectorServer(need('notion'))).toEqual({
      url: 'https://mcp.notion.com/mcp',
      oauth: true,
    });
  });
});

describe('omnexx connect / disconnect', () => {
  it('lists the catalog when given no name', async () => {
    const { first } = await cli(['connect']);
    expect(first.out).toMatch(/mail & calendar[\s\S]*gmail/);
    expect(first.out).toContain('notion');
  });

  it('connects a token app: config refers to the secret, the token sits in the 0600 secrets file', async () => {
    const { env, first } = await cli(['connect', 'github', '--set', 'Authorization=ghp_abc']);
    expect(first.code).toBe(EXIT.ok);
    const config = await readFile(join(home(env), 'config.toml'), 'utf8');
    expect(config).toContain('[mcp.servers.github]');
    expect(config).not.toContain('ghp_abc');
    const secretsPath = join(home(env), 'mcp-secrets.json');
    expect(JSON.parse(await readFile(secretsPath, 'utf8'))).toEqual({
      github: { Authorization: 'Bearer ghp_abc' },
    });
    expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
  });

  it('refuses a token app without its token and writes nothing', async () => {
    const { env, first } = await cli(['connect', 'github']);
    expect(first.code).toBe(EXIT.error);
    expect(first.err).toContain('--set Authorization=');
    await expect(readFile(join(home(env), 'config.toml'), 'utf8')).rejects.toThrow();
  });

  it('disconnect removes the server and its secrets', async () => {
    const { env, run } = await cli(['connect', 'github', '--set', 'Authorization=ghp_abc']);
    const r = await run(['disconnect', 'github']);
    expect(r.out).toContain('Disconnected github');
    const config = await readFile(join(home(env), 'config.toml'), 'utf8');
    expect(config).not.toContain('github');
    const secrets = await readFile(join(home(env), 'mcp-secrets.json'), 'utf8');
    expect(secrets).not.toContain('ghp_abc');
  });

  it('points unknown names at the registry', async () => {
    const { first } = await cli(['connect', 'nosuchapp']);
    expect(first.code).toBe(EXIT.error);
    expect(first.err).toContain('omnexx mcp add nosuchapp');
  });
});
