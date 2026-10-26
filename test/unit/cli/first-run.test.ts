import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ensureFirstRun } from '../../../src/cli/first-run.js';
import type { CliIO } from '../../../src/cli/io.js';
import { loadConfig } from '../../../src/config/load.js';
import { keyFile } from '../../../src/auth/keys.js';
import { resolvePaths, userConfigFile } from '../../../src/core/paths.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const KEY = 'sk-ant-testkey-0123456789abcdef';

function makeIO(
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { isTTY?: boolean; fetch?: CliIO['fetch'] } = {},
): { io: CliIO; stdin: PassThrough; out: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c: Buffer) => {
    text += c.toString('utf8');
  });
  const io: CliIO = {
    stdout,
    stderr: new PassThrough(),
    stdin,
    env,
    cwd,
    isTTY: opts.isTTY ?? true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  return { io, stdin, out: () => text };
}

async function waitFor(out: () => string, needle: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!out().includes(needle)) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fetch that lists one model for any /models URL, 404 otherwise. */
const listFetch: CliIO['fetch'] = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/models'))
    return Promise.resolve(Response.json({ data: [{ id: 'listed-model-1' }] }));
  return Promise.resolve(new Response('nope', { status: 404 }));
};

describe('first run', () => {
  it('does nothing when a provider is already keyed', async () => {
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-already-there' });
    const { io, out } = makeIO(env, await tempDir());
    expect(await ensureFirstRun(io)).toBe(true);
    expect(out()).toBe('');
  });

  it('uses keys from the environment, then takes the probed model on Enter', async () => {
    const env = await isolatedEnv({ GROQ_API_KEY: 'gsk-env-key' });
    const cwd = await tempDir();
    const { io, stdin, out } = makeIO(env, cwd, { fetch: listFetch });
    const done = ensureFirstRun(io);
    await waitFor(out, 'Model [');
    stdin.write('\n');
    expect(await done).toBe(true);
    const toml = await readFile(userConfigFile(resolvePaths(env)), 'utf8');
    expect(toml).toContain('provider = "groq"');
    expect(toml).toContain('model = "groq:listed-model-1"');
    expect(toml).not.toContain('gsk-env-key');
    const { config } = await loadConfig({ cwd, env });
    expect(config.models.chat).toEqual(['groq:listed-model-1']);
    expect(config.providers.endpoints.groq?.base_url).toContain('groq');
  });

  it('pastes a key, detects its provider, stores it 0600, and records provider + model', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const { io, stdin, out } = makeIO(env, cwd, { fetch: listFetch });
    const done = ensureFirstRun(io);
    await waitFor(out, 'Paste an API key');
    stdin.write(`${KEY}\n`);
    await waitFor(out, 'Model [');
    stdin.write('\n');
    expect(await done).toBe(true);
    const stored = await readFile(keyFile(resolvePaths(env), 'anthropic'), 'utf8');
    expect(stored.trim()).toBe(KEY);
    const toml = await readFile(userConfigFile(resolvePaths(env)), 'utf8');
    expect(toml).toContain('provider = "anthropic"');
    expect(toml).toContain('model = "anthropic:listed-model-1"');
    expect(toml).not.toContain(KEY);
    const { config } = await loadConfig({ cwd, env });
    expect(config.models.worker).toEqual(['anthropic:listed-model-1']);
  });

  it('lets the person type a model instead of the suggestion', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const { io, stdin, out } = makeIO(env, cwd, { fetch: listFetch });
    const done = ensureFirstRun(io);
    await waitFor(out, 'Paste an API key');
    stdin.write(`${KEY}\n`);
    await waitFor(out, 'Model [');
    stdin.write('anthropic:sonnet\n');
    expect(await done).toBe(true);
    const toml = await readFile(userConfigFile(resolvePaths(env)), 'utf8');
    expect(toml).toContain('model = "anthropic:sonnet"');
  });

  it('non-interactive: prints the two steps and does nothing', async () => {
    const env = await isolatedEnv();
    const { io, out } = makeIO(env, await tempDir(), { isTTY: false });
    expect(await ensureFirstRun(io)).toBe(false);
    expect(out()).toMatch(/no model set up yet/);
    await expect(readFile(userConfigFile(resolvePaths(env)), 'utf8')).rejects.toThrow();
  });
});
