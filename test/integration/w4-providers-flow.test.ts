/**
 * W4 acceptance: with only GROQ_API_KEY set and a fake server standing in for
 * Groq, `providers add groq` -> `models list --remote` -> `models test groq:<id>`
 * all succeed with no hand-edited TOML.
 */
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import type { CliIO } from '../../src/cli/io.js';
import { isolatedEnv, tempDir } from '../support/tmp.js';
import { json, mockServer } from '../support/mock-http.js';

function collect(s: PassThrough): () => string {
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  fetchFn: typeof fetch,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const io: CliIO = {
    stdout,
    stderr,
    stdin: Readable.from([]),
    env,
    cwd,
    isTTY: false,
    fetch: fetchFn,
  };
  const code = await runCli(argv, io);
  return { code, stdout: out(), stderr: err() };
}

const MODEL = 'llama-3.3-70b-versatile';

describe('W4 groq flow against a fake server', () => {
  it('providers add -> models list --remote -> models test, no hand-edited TOML', async () => {
    const srv = await mockServer((r, res) => {
      if (r.url === '/openai/v1/models') {
        json(res, 200, { data: [{ id: MODEL, context_length: 131072 }] });
      } else if (r.url === '/openai/v1/chat/completions') {
        const body = JSON.parse(r.body) as { model?: string; max_tokens?: number };
        // providers add uses model "test" with maxTokens 1; models test uses the real id.
        if (body.model === 'test' && body.max_tokens === 1) {
          json(res, 200, {
            model: 'test',
            choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          });
        } else if (body.model === MODEL) {
          json(res, 200, {
            model: MODEL,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  tool_calls: [{ id: 'c1', function: { name: 'ping', arguments: '{}' } }],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          });
        } else json(res, 404, { error: { message: `unknown model ${body.model ?? ''}` } });
      } else json(res, 404, { error: { message: 'not found' } });
    });
    const key = `gsk-test-${'k'.repeat(8)}`;
    const env = await isolatedEnv({ GROQ_API_KEY: key });
    const cwd = await tempDir();
    const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = input instanceof Request ? input.url : input.toString();
      return fetch(`${srv.url}${raw.slice('http://groq.test'.length)}`, init);
    };
    // Point the groq template at the fake server via an explicit base URL.
    const add = await run(
      ['providers', 'add', 'groq', '--base-url', 'http://groq.test/openai/v1'],
      env,
      cwd,
      fetchFn,
    );
    expect(`${add.stdout} ${add.stderr}`).toMatch(/Added/);
    expect(add.code).toBe(0);
    const list = await run(['models', 'list', '--remote', '--provider', 'groq'], env, cwd, fetchFn);
    expect(list.stdout).toContain(`groq:${MODEL}`);
    expect(list.stdout).toMatch(/131072/);
    expect(list.code).toBe(0);
    const test = await run(['models', 'test', `groq:${MODEL}`], env, cwd, fetchFn);
    expect(test.stdout).toMatch(/tool call to ping/);
    expect(test.code).toBe(0);
    // No TOML was hand-edited: the user config only contains what `providers add` wrote.
    const { readFile } = await import('node:fs/promises');
    const { resolvePaths, userConfigFile } = await import('../../src/core/paths.js');
    const text = await readFile(userConfigFile(resolvePaths(env)), 'utf8');
    expect(text).toMatch(/\[providers\.endpoints\.groq\]/);
    expect(text).not.toContain(key);
  });

  it('auth set/clear works for any provider name; env wins over file', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolvePaths } = await import('../../src/core/paths.js');
    const { findProviderKey, keyFile } = await import('../../src/auth/keys.js');
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const passFetch: typeof fetch = () => Promise.reject(new Error('no network'));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const mkIo = (stdin: string): CliIO => ({
      stdout,
      stderr,
      stdin: Readable.from([stdin]),
      env,
      cwd,
      isTTY: false,
      fetch: passFetch,
    });
    expect(await runCli(['auth', 'set', 'groq'], mkIo('gsk-file-key\n'))).toBe(0);
    const paths = resolvePaths(env);
    expect((await readFile(keyFile(paths, 'groq'), 'utf8')).trim()).toBe('gsk-file-key');
    expect((await findProviderKey(paths, env, 'groq', 'GROQ_API_KEY'))?.source).toBe(
      'credentials file',
    );
    const withEnv = { ...env, GROQ_API_KEY: 'gsk-env-key' };
    expect((await findProviderKey(paths, withEnv, 'groq', 'GROQ_API_KEY'))?.key).toBe(
      'gsk-env-key',
    );
    expect(await runCli(['auth', 'clear', 'groq'], mkIo(''))).toBe(0);
    expect(await findProviderKey(paths, env, 'groq', 'GROQ_API_KEY')).toBeUndefined();
    afterEach(() => undefined);
  });
});
