import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { storeKey } from '../../../src/auth/keys.js';
import { resolveRunDeps } from '../../../src/cli/run-deps.js';
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
