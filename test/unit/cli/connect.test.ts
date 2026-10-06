import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connect, nameForUrl, providerForKey } from '../../../src/cli/connect.js';
import { loadConfig } from '../../../src/config/load.js';
import { modelsFetch, testIO } from '../../support/connect.js';

describe('connect', () => {
  it('recognises keys and names URLs', () => {
    expect(providerForKey('sk-ant-api03-abcdefghijklmnopqrstuv')).toBe('anthropic');
    expect(providerForKey('sk-or-v1-abcdefghijklmnopqrstuv')).toBe('openrouter');
    expect(providerForKey('gsk_abcdefghijklmnopqrstuv')).toBe('groq');
    expect(providerForKey('sk-proj-abcdefghijklmnopqrstuv')).toBe('openai');
    expect(providerForKey('build a monkey landing page')).toBeUndefined();
    expect(providerForKey('sk-short')).toBeUndefined();
    expect(nameForUrl('http://localhost:11434/v1')).toBe('ollama');
    expect(nameForUrl('http://localhost:9999/v1')).toBe('local');
    expect(nameForUrl('https://api.example-llm.com/v1')).toBe('example-llm');
    expect(nameForUrl('https://openrouter.ai/api/v1')).toBe('openrouter');
  });

  it('a pasted key adds the provider, stores the key 0600 and lists models', async () => {
    const seen: string[] = [];
    const io = await testIO(modelsFetch(['deepseek/v4', 'qwen/q3'], seen));
    const r = await connect(io, 'sk-or-v1-abcdefghijklmnopqrstuvwxyz');
    expect(r).toMatchObject({ name: 'openrouter', added: true, keyStored: true });
    expect(r.suggested).toBe('openrouter:deepseek/v4');
    expect(seen[0]).toContain('Bearer sk-or-v1-abcdefghijklmnopqrstuvwxyz');
    const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
    expect(config.providers.endpoints.openrouter?.base_url).toBe('https://openrouter.ai/api/v1');
    const again = await connect(io, 'openrouter');
    expect(again.added).toBe(false);
    const toml = await readFile(join(io.env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'), 'utf8');
    expect(toml).not.toContain('sk-or-');
  });

  it('a local URL needs no key and reports a dead server', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const r = await connect(await testIO(down), 'http://localhost:11434/v1');
    expect(r.name).toBe('ollama');
    expect(r.notes.join()).toContain('is the server running');
  });

  it('anthropic keys are stored without an endpoint', async () => {
    const r = await connect(await testIO(modelsFetch([])), 'sk-ant-api03-abcdefghijklmnopqrstuv');
    expect(r).toMatchObject({ name: 'anthropic', keyStored: true, suggested: 'anthropic:sonnet' });
  });

  it('rejects unknown names', async () => {
    await expect(connect(await testIO(modelsFetch([])), 'nope')).rejects.toThrow(
      /unknown provider/,
    );
  });
});
