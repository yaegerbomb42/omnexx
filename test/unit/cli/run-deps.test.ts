import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { storeKey } from '../../../src/auth/keys.js';
import { resolveRunDeps, stallTimeoutMs } from '../../../src/cli/run-deps.js';
import { resolvePaths } from '../../../src/core/paths.js';
import type { CliIO } from '../../../src/cli/io.js';
import type { CompletionRequest } from '../../../src/providers/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(kind: string, env: NodeJS.ProcessEnv = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'omnexx-deps-'));
  const home = await mkdtemp(join(tmpdir(), 'omnexx-home-'));
  dirs.push(repo, home);
  await writeFile(
    join(repo, 'omnexx.toml'),
    `[models]
planner = "ep:m1"
worker = "ep:m1"
cheap = "ep:m1"

[providers.endpoints.ep]
kind = "${kind}"
base_url = "http://127.0.0.1:9"
api_key_env = "EP_KEY"
free = true
`,
  );
  const urls: string[] = [];
  const io: CliIO = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: { OMNEXX_HOME: home, OMNEXX_CONFIG_HOME: home, ...env },
    cwd: repo,
    isTTY: false,
    fetch: (input) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(new Error('offline'));
    },
  };
  return { repo, home, io, urls };
}

const req: CompletionRequest = {
  model: 'm1',
  route: 'ep',
  system: [{ text: 'x' }],
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 10,
  messageBreakpoints: [],
};

describe('stallTimeoutMs', () => {
  it('cuts remote endpoints at 3 minutes and leaves local ones to request_timeout', () => {
    expect(stallTimeoutMs(undefined, 'https://api.example.com/v1')).toBe(180_000);
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:1234/v1',
    ])
      expect(stallTimeoutMs(undefined, url)).toBeUndefined();
  });

  it('follows an explicit setting either way', () => {
    expect(stallTimeoutMs('90s', 'http://127.0.0.1:9/v1')).toBe(90_000);
    expect(stallTimeoutMs('off', 'https://api.example.com/v1')).toBeUndefined();
  });
});

describe('pool providers with no key', () => {
  async function setupPool(pool: string[] | undefined, worker: string) {
    const repo = await mkdtemp(join(tmpdir(), 'omnexx-pool-'));
    const home = await mkdtemp(join(tmpdir(), 'omnexx-pool-home-'));
    dirs.push(repo, home);
    await writeFile(
      join(repo, 'omnexx.toml'),
      `[models]\nplanner = "ep:m1"\nworker = ${worker}\ncheap = "ep:m1"\n` +
        (pool ? `\n[pool]\nproviders = [${pool.map((p) => `"${p}"`).join(', ')}]\n` : '') +
        `\n[providers.endpoints.ep]\nkind = "openai"\nbase_url = "http://127.0.0.1:9"\napi_key_env = "EP_KEY"\nfree = true\n` +
        `\n[providers.endpoints.ghost]\nkind = "openai"\nbase_url = "http://127.0.0.1:9"\napi_key_env = "GHOST_KEY"\nfree = true\n`,
    );
    let stderr = '';
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: { OMNEXX_HOME: home, OMNEXX_CONFIG_HOME: home, EP_KEY: 'k-123' },
      cwd: repo,
      isTTY: false,
    };
    (io.stderr as PassThrough).on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    return { repo, io, stderr: () => stderr };
  }

  it('skips a pool-listed provider with no key and prunes its models from the chains', async () => {
    const { repo, io, stderr } = await setupPool(['ghost', 'ep'], '["ghost:m1", "ep:m1"]');
    const { config } = await resolveRunDeps(io, repo);
    expect(config.models.worker).toEqual(['ep:m1']);
    expect(config.models.planner).toBe('ep:m1');
    expect(stderr()).toContain('ghost');
    expect(stderr()).toContain('skipping it');
  });

  it('a pruned chain falls back to the working provider, not the key-less one', async () => {
    const { repo, io } = await setupPool(['ghost'], '["ghost:m1", "ep:m1"]');
    const { config } = await resolveRunDeps(io, repo);
    // ghost was never built, so the worker chain keeps only the provider that can answer;
    // Run's pool filter then falls back to this chain (ep is not in the list).
    expect(config.models.worker).toEqual(['ep:m1']);
  });

  it('still throws when the key-less provider is not in the pool list', async () => {
    const { repo, io } = await setupPool(undefined, '["ghost:m1", "ep:m1"]');
    await expect(resolveRunDeps(io, repo)).rejects.toThrow(/needs GHOST_KEY/);
  });
});

describe('resolveRunDeps endpoint kinds', () => {
  it.each([
    ['openai', '/chat/completions'],
    ['responses', '/responses'],
    ['gemini', ':generateContent'],
  ])('kind = %s calls the matching API', async (kind, path) => {
    const { repo, io, urls } = await setup(kind, { EP_KEY: 'k-123' });
    const { deps } = await resolveRunDeps(io, repo);
    await deps.provider.complete(req).catch(() => undefined);
    expect(urls[0]).toContain(path);
    expect(deps.secrets).toContain('k-123');
  });

  it('uses a key stored with `omnexx auth set` when the env var is unset', async () => {
    const { repo, io } = await setup('openai');
    await storeKey(resolvePaths(io.env), 'ep', 'k-stored');
    const { deps } = await resolveRunDeps(io, repo);
    expect(deps.secrets).toContain('k-stored');
  });

  it('names both fixes when no key is found', async () => {
    const { repo, io } = await setup('openai');
    await expect(resolveRunDeps(io, repo)).rejects.toThrow(/needs EP_KEY/);
  });
});
