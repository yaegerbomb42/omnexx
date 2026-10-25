import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/agent-cards.js';
import type { CliIO } from '../../../src/cli/io.js';
import { tempDir } from '../../support/tmp.js';

const CARD = {
  name: 'My Agent',
  description: 'A test agent',
  skills: [],
  supportedInterfaces: [{ url: 'http://example.com/rpc', protocolBinding: 'JSONRPC' }],
};

async function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  let out = '';
  let err = '';
  let code = 0;
  const fetchFn = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(CARD),
    } as unknown as Response);
  const io: CliIO = {
    stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    cwd,
    isTTY: false,
    env,
    fetch: fetchFn,
  };
  const program = new Command().exitOverride();
  register(program, io, (c) => (code = c));
  await program.parseAsync(['node', 'omnexx', ...args]);
  return { out, err, code };
}

describe('omnexx agent-cards add', () => {
  async function setup() {
    const base = await tempDir('omnexx-cards-cli-');
    const env = {
      PATH: process.env.PATH,
      HOME: join(base, 'home'),
      OMNEXX_HOME: join(base, 'state'),
      OMNEXX_CONFIG_HOME: join(base, 'config'),
    };
    await mkdir(env.OMNEXX_CONFIG_HOME, { recursive: true });
    const repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    return { env, repo };
  }

  it('rejects a name whose sanitized form is empty/dashes only', async () => {
    const { env, repo } = await setup();
    const r = await cli(['agent-cards', 'add', 'https://example.com', '--name', '!!!'], repo, env);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not produce a valid agent name/);
  });

  it('rejects a dash-only name that would sanitize to a single dash', async () => {
    const { env, repo } = await setup();
    const r = await cli(['agent-cards', 'add', 'https://example.com', '--name', '--'], repo, env);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not produce a valid agent name/);
  });

  it('adds a valid name successfully', async () => {
    const { env, repo } = await setup();
    const r = await cli(['agent-cards', 'add', 'https://example.com'], repo, env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Added the remote agent "my-agent"/);
  });
});
