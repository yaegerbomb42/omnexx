import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import { ollamaModels, pickOllamaModel, useOllama } from '../../../src/cli/ollama.js';
import { UsageError } from '../../../src/errors.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

/** A local Ollama with these models pulled, or none running when `models` is undefined. */
function fakeOllama(models: string[] | undefined): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!models) return Promise.reject(new TypeError('fetch failed'));
    if (url.endsWith('/api/tags'))
      return Promise.resolve(Response.json({ models: models.map((name) => ({ name })) }));
    if (url.endsWith('/v1/models'))
      return Promise.resolve(Response.json({ data: models.map((id) => ({ id })) }));
    return Promise.resolve(new Response('', { status: 404 }));
  };
}

async function io(models: string[] | undefined): Promise<CliIO> {
  const sink = { write: () => true } as unknown as NodeJS.WriteStream;
  return {
    stdout: sink,
    stderr: sink,
    stdin: process.stdin,
    cwd: await tempDir(),
    isTTY: false,
    env: await isolatedEnv(),
    fetch: fakeOllama(models),
  };
}

describe('Ollama quickstart', () => {
  it('lists pulled models, or undefined when Ollama is not running', async () => {
    expect(await ollamaModels(fakeOllama(['llama3.3:latest']))).toEqual(['llama3.3:latest']);
    expect(await ollamaModels(fakeOllama(undefined))).toBeUndefined();
  });

  it('prefers a coding model, honours a named one, with or without :latest', () => {
    const pulled = ['llama3.3:latest', 'qwen2.5-coder:7b', 'gpt-oss:20b'];
    expect(pickOllamaModel(pulled)).toBe('qwen2.5-coder:7b');
    expect(pickOllamaModel(pulled, 'llama3.3')).toBe('llama3.3:latest');
    expect(pickOllamaModel(pulled, 'mistral')).toBeUndefined();
    expect(pickOllamaModel(['phi4:latest'])).toBe('phi4:latest');
  });

  it('connects Ollama once and returns the model to chat with', async () => {
    const cli = await io(['llama3.3:latest', 'qwen2.5-coder:7b']);
    expect(await useOllama(cli)).toBe('ollama:qwen2.5-coder:7b');
    const config = await readFile(join(cli.env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'), 'utf8');
    expect(config).toContain('[providers.endpoints.ollama]');
    expect(config).toContain('http://localhost:11434/v1');
  });

  it('says how to fix it when Ollama is not running or lacks the model', async () => {
    await expect(useOllama(await io(undefined))).rejects.toThrow(UsageError);
    await expect(useOllama(await io(undefined))).rejects.toThrow(/isn't answering/);
    await expect(useOllama(await io(['llama3.3:latest']), 'mistral')).rejects.toThrow(
      /no model "mistral"/,
    );
    await expect(useOllama(await io([]))).rejects.toThrow(/no models yet/);
  });
});
