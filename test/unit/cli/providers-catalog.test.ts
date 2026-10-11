import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PROVIDER_TEMPLATES } from '../../../src/cli/commands/providers.js';
import { connectFromEnv, envKeys, providerForKey } from '../../../src/cli/connect.js';
import type { CliIO } from '../../../src/cli/io.js';
import { loadConfig } from '../../../src/config/load.js';
import { Session } from '../../../src/tui/session.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('provider catalog', () => {
  it('every hosted provider has an https URL, a key variable and a signup link', () => {
    const hosted = Object.entries(PROVIDER_TEMPLATES).filter(
      ([n, t]) => !t.local && n !== 'custom',
    );
    expect(hosted.length).toBeGreaterThanOrEqual(24);
    for (const [name, t] of hosted) {
      expect(t.baseUrl, name).toMatch(/^https:\/\//);
      expect(t.keyEnv, name).toMatch(/^[A-Z_]+$/);
      expect(t.signup, name).toMatch(/^https:\/\//);
    }
    expect(PROVIDER_TEMPLATES.gemini?.kind).toBe('gemini');
    for (const n of ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'litellm', 'jan'])
      expect(PROVIDER_TEMPLATES[n]?.local, n).toBe(true);
  });

  it('recognises keys by prefix, the longest prefix winning', () => {
    const k = (p: string) => providerForKey(`${p}${'x'.repeat(30)}`);
    expect(k('sk-ant-')).toBe('anthropic');
    expect(k('sk-or-v1-')).toBe('openrouter');
    expect(k('sk-proj-')).toBe('openai');
    expect(k('nvapi-')).toBe('nvidia');
    expect(k('csk-')).toBe('cerebras');
    expect(k('hf_')).toBe('huggingface');
    expect(k('pplx-')).toBe('perplexity');
    expect(k('gsk_')).toBe('groq');
  });

  it('/connect env uses the keys already in the environment without copying them', async () => {
    const env = await isolatedEnv({
      OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaa',
      GROQ_API_KEY: 'gsk_bbbbbbbbbbbbbbbbbbbb',
    });
    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: await tempDir(),
      isTTY: false,
    } as CliIO;
    expect((await envKeys(io)).map((k) => k.name)).toEqual(['openai', 'groq']);
    expect((await connectFromEnv(io)).map((k) => k.label)).toEqual(['OpenAI', 'Groq']);
    const { config } = await loadConfig({ cwd: io.cwd, env });
    expect(config.providers.endpoints.openai).toMatchObject({ api_key_env: 'OPENAI_API_KEY' });
    expect(config.providers.endpoints.groq).toMatchObject({ api_key_env: 'GROQ_API_KEY' });
    const toml = await readFile(join(env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'), 'utf8');
    expect(toml).not.toContain('sk-proj-');
    expect(await envKeys(io)).toEqual([]);
  });

  it('the first-run welcome names the keys it found and how to start', async () => {
    const env = await isolatedEnv({ MISTRAL_API_KEY: 'mmmmmmmmmmmmmmmmmmmmmmmm' });
    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: await tempDir(),
      isTTY: false,
      // No local Ollama here, whatever runs on this machine.
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    } as CliIO;
    const s = new Session(io, () => Promise.resolve(0));
    await s.greet(true);
    const text = s.entries.map((e) => e.text).join('\n');
    expect(text).toMatch(/welcome to omnexx/);
    expect(text).toMatch(/\/connect env .*Mistral/);
    expect(text).toMatch(/2\. ask:/);
  });

  it('the first run connects a running Ollama by itself', async () => {
    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv(),
      cwd: await tempDir(),
      isTTY: false,
      fetch: (input: string | URL | Request) =>
        Promise.resolve(
          String(input instanceof Request ? input.url : input).endsWith('/api/tags')
            ? Response.json({ models: [{ name: 'qwen2.5-coder:7b' }] })
            : Response.json({ data: [{ id: 'qwen2.5-coder:7b' }] }),
        ),
    } as CliIO;
    const s = new Session(io, () => Promise.resolve(0));
    await s.greet(false);
    expect(s.entries.map((e) => e.text).join('\n')).toContain(
      'found Ollama running locally: chatting with ollama:qwen2.5-coder:7b',
    );
    expect(s.chatModelName).toBe('ollama:qwen2.5-coder:7b');
  });
});
