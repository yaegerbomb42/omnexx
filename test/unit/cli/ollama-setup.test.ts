import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readRoles } from '../../../src/config/roles.js';
import { resolvePaths } from '../../../src/core/paths.js';
import type { CliIO } from '../../../src/cli/io.js';
import { ollamaBase, rankOllamaModels } from '../../../src/cli/ollama.js';
import {
  derivedName,
  pullOllamaModel,
  setupOllama,
  suggestPull,
} from '../../../src/cli/ollama-setup.js';
import { startWithOllama } from '../../../src/cli/ollama-start.js';
import { UsageError } from '../../../src/errors.js';
import { Session } from '../../../src/tui/session.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const GIB = 1024 ** 3;

interface FakeModel {
  tools: boolean;
  ctx?: number;
  size?: string;
}

interface FakeOllama {
  fetch: typeof fetch;
  calls: { url: string; body: Record<string, unknown> }[];
  models: Map<string, FakeModel>;
}

/**
 * A scripted Ollama (never the real one on this machine): /api/tags, /api/show, /api/create,
 * /api/pull and /v1/models over the given models; `undefined` means nothing is listening.
 */
function fakeOllama(
  models: Record<string, FakeModel> | undefined,
  opts: { pullAdds?: FakeModel; createFails?: boolean } = {},
): FakeOllama {
  const state = new Map(Object.entries(models ?? {}));
  const calls: FakeOllama['calls'] = [];
  const respond = (input: Parameters<typeof fetch>[0], init?: RequestInit): Response => {
    if (!models) throw new TypeError('fetch failed');
    const url = String(input instanceof Request ? input.url : input);
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ url, body });
    const path = new URL(url).pathname;
    if (path === '/api/tags')
      return Response.json({ models: [...state.keys()].map((name) => ({ name })) });
    if (path === '/v1/models')
      return Response.json({ data: [...state.keys()].map((id) => ({ id })) });
    if (path === '/api/show') {
      const m = state.get(String(body.model));
      if (!m) return new Response('not found', { status: 404 });
      return Response.json({
        capabilities: m.tools ? ['completion', 'tools'] : ['completion'],
        model_info: m.ctx ? { 'qwen3moe.context_length': m.ctx } : {},
        details: { parameter_size: m.size ?? '7.6B' },
      });
    }
    if (path === '/api/create') {
      if (opts.createFails) return new Response('nope', { status: 500 });
      const from = state.get(String(body.from));
      if (from) state.set(String(body.model), from);
      return Response.json({ status: 'success' });
    }
    if (path === '/api/pull') {
      if (opts.pullAdds) state.set(String(body.model), opts.pullAdds);
      const lines = [
        { status: 'pulling manifest' },
        { status: 'pulling abc', total: 100, completed: 50 },
        { status: 'pulling abc', total: 100, completed: 100 },
        { status: 'success' },
      ];
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n'));
    }
    return new Response('', { status: 404 });
  };
  const fetchFn: typeof fetch = (input, init) => {
    try {
      return Promise.resolve(respond(input, init));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  return { fetch: fetchFn, calls, models: state };
}

async function cliIO(fake: FakeOllama, extra: Partial<CliIO> = {}): Promise<CliIO> {
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    cwd: await tempDir(),
    isTTY: false,
    env: await isolatedEnv(),
    fetch: fake.fetch,
    ...extra,
  };
}

describe('ollamaBase', () => {
  it('reads OLLAMA_HOST in every form Ollama accepts', () => {
    expect(ollamaBase({})).toBe('http://localhost:11434');
    expect(ollamaBase({ OLLAMA_HOST: '0.0.0.0' })).toBe('http://127.0.0.1:11434');
    expect(ollamaBase({ OLLAMA_HOST: '0.0.0.0:8080' })).toBe('http://127.0.0.1:8080');
    expect(ollamaBase({ OLLAMA_HOST: 'box.lan' })).toBe('http://box.lan:11434');
    expect(ollamaBase({ OLLAMA_HOST: 'https://ollama.example.com' })).toBe(
      'https://ollama.example.com',
    );
  });
});

describe('rankOllamaModels', () => {
  it('drops models without tools and prefers coding families, then size, then context', () => {
    const ranked = rankOllamaModels([
      { name: 'llama3.3:latest', tools: true, maxContext: 131072, paramsB: 70 },
      { name: 'gemma3:27b', tools: false, maxContext: 131072, paramsB: 27 },
      { name: 'qwen2.5-coder:7b', tools: true, maxContext: 32768, paramsB: 7.6 },
      { name: 'qwen2.5-coder:14b', tools: true, maxContext: 32768, paramsB: 14.8 },
      { name: 'qwen3-coder:30b', tools: true, maxContext: 262144, paramsB: 30.5 },
    ]).map((m) => m.name);
    expect(ranked).toEqual([
      'qwen3-coder:30b',
      'qwen2.5-coder:14b',
      'qwen2.5-coder:7b',
      'llama3.3:latest',
    ]);
  });

  it('suggests a small model on small machines', () => {
    expect(suggestPull(64 * GIB).model).toBe('qwen3-coder');
    expect(suggestPull(8 * GIB).model).toBe('qwen2.5-coder:7b');
    expect(derivedName('qwen3-coder:30b')).toBe('omnexx-qwen3-coder-30b');
    expect(derivedName('devstral:latest')).toBe('omnexx-devstral');
  });
});

describe('setupOllama', () => {
  it('picks the best tool model, raises its context, connects it and saves every role', async () => {
    const fake = fakeOllama({
      'gemma3:27b': { tools: false, ctx: 131072 },
      'llama3.2:3b': { tools: true, ctx: 131072, size: '3.2B' },
      'qwen3-coder:30b': { tools: true, ctx: 262144, size: '30.5B' },
      'kimi-k2.7-code:cloud': { tools: true },
    });
    const io = await cliIO(fake);
    const r = await setupOllama(io, { saveRoles: true, memoryBytes: 64 * GIB });
    expect(r).toMatchObject({
      kind: 'ready',
      model: 'qwen3-coder:30b',
      ref: 'ollama:omnexx-qwen3-coder-30b',
      numCtx: 32768,
    });
    expect(r.line).toMatch(/^using Ollama's qwen3-coder:30b \(local, free, tools, 32k context\)/);
    const create = fake.calls.find((c) => c.url.endsWith('/api/create'));
    expect(create?.body).toMatchObject({
      model: 'omnexx-qwen3-coder-30b',
      from: 'qwen3-coder:30b',
      parameters: { num_ctx: 32768 },
    });
    // The cloud model is never described, let alone picked.
    expect(fake.calls.some((c) => c.body.model === 'kimi-k2.7-code:cloud')).toBe(false);
    const roles = await readRoles(resolvePaths(io.env));
    expect(roles.models).toMatchObject({
      chat: ['ollama:omnexx-qwen3-coder-30b'],
      planner: ['ollama:omnexx-qwen3-coder-30b'],
      worker: ['ollama:omnexx-qwen3-coder-30b'],
    });
    const config = await readFile(join(io.env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'), 'utf8');
    expect(config).toContain('http://localhost:11434/v1');

    // Run again: the tuned copy is reused, not recreated or picked as a model of its own.
    fake.calls.length = 0;
    const again = await setupOllama(io, { memoryBytes: 64 * GIB });
    expect(again).toMatchObject({ ref: 'ollama:omnexx-qwen3-coder-30b', rolesSaved: false });
    expect(fake.calls.some((c) => c.url.endsWith('/api/create'))).toBe(false);
  });

  it('caps the window at what the model supports and shrinks it on small machines', async () => {
    const small = await setupOllama(
      await cliIO(fakeOllama({ 'qwen2.5-coder:7b': { tools: true, ctx: 32768 } })),
      { memoryBytes: 8 * GIB },
    );
    expect(small).toMatchObject({ numCtx: 16384 });
    const short = await setupOllama(
      await cliIO(fakeOllama({ 'mistral:7b': { tools: true, ctx: 8192 } })),
      { memoryBytes: 64 * GIB },
    );
    expect(short).toMatchObject({ numCtx: 8192 });
  });

  it('falls back to the pulled model when Ollama cannot make a tuned copy', async () => {
    const r = await setupOllama(
      await cliIO(fakeOllama({ 'devstral:24b': { tools: true } }, { createFails: true })),
    );
    expect(r).toMatchObject({ kind: 'ready', ref: 'ollama:devstral:24b', numCtx: undefined });
  });

  it('suggests a pull when nothing installed can call tools, or nothing is installed', async () => {
    const noTools = await setupOllama(await cliIO(fakeOllama({ 'gemma3:27b': { tools: false } })), {
      memoryBytes: 64 * GIB,
    });
    expect(noTools).toMatchObject({ kind: 'no-model', pull: { model: 'qwen3-coder' } });
    expect(noTools.line).toMatch(/can call tools.*ollama pull qwen3-coder/);
    const empty = await setupOllama(await cliIO(fakeOllama({})), { memoryBytes: 8 * GIB });
    expect(empty.line).toMatch(/no models yet.*ollama pull qwen2\.5-coder:7b/);
  });

  it('says how to install or start Ollama when nothing answers', async () => {
    const r = await setupOllama(await cliIO(fakeOllama(undefined)));
    expect(r.kind).toBe('down');
    expect(r.line).toMatch(/ollama\.com\/download/);
    expect(r.line).toMatch(/ollama serve/);
  });
});

describe('pullOllamaModel', () => {
  it('streams progress until the pull finishes', async () => {
    const seen: (number | undefined)[] = [];
    await pullOllamaModel(await cliIO(fakeOllama({})), 'qwen3-coder', (p) => seen.push(p.percent));
    expect(seen).toEqual([undefined, 50, 100, undefined]);
  });
});

describe('omnexx --ollama', () => {
  it('prints the pick in one line and returns the tuned model', async () => {
    const io = await cliIO(fakeOllama({ 'qwen3-coder:30b': { tools: true, ctx: 262144 } }));
    let err = '';
    io.stderr.on('data', (d: Buffer) => (err += d.toString()));
    expect(await startWithOllama(io)).toBe('ollama:omnexx-qwen3-coder-30b');
    expect(err.trim().split('\n')).toHaveLength(1);
  });

  it('offers to pull on a terminal, then uses the new model', async () => {
    const fake = fakeOllama({}, { pullAdds: { tools: true, ctx: 32768 } });
    const stdin = new PassThrough();
    const io = await cliIO(fake, { stdin, isTTY: true });
    stdin.end('\n');
    expect(await startWithOllama(io)).toMatch(/^ollama:omnexx-/);
    expect(fake.calls.some((c) => c.url.endsWith('/api/pull'))).toBe(true);
  });

  it('fails with the fix when not on a terminal or Ollama is down', async () => {
    await expect(startWithOllama(await cliIO(fakeOllama({})))).rejects.toThrow(/ollama pull/);
    await expect(startWithOllama(await cliIO(fakeOllama(undefined)))).rejects.toThrow(UsageError);
  });
});

describe('first run in the session (TUI and VS Code panel)', () => {
  it('sets up Ollama with no other provider and says what it picked', async () => {
    const io = await cliIO(fakeOllama({ 'qwen3-coder:30b': { tools: true, ctx: 262144 } }));
    const s = new Session(io, () => Promise.resolve(0));
    await s.greet(false);
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(/using Ollama's qwen3-coder:30b/);
    expect(s.chatModelName).toBe('ollama:omnexx-qwen3-coder-30b');
  });

  it('offers a one-key pull with named buttons, then picks the pulled model', async () => {
    const fake = fakeOllama({}, { pullAdds: { tools: true, ctx: 32768 } });
    const s = new Session(await cliIO(fake), () => Promise.resolve(0));
    await s.greet(false);
    expect(s.pending?.labels).toEqual({ yes: 'Pull it now', no: 'Not now' });
    await s.submit('y');
    await expect.poll(() => s.chatModelName).toMatch(/^ollama:omnexx-qwen/);
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(/qwen.*: 100%/);
  });

  it('shows how to install Ollama in the welcome when nothing is set up', async () => {
    const s = new Session(await cliIO(fakeOllama(undefined)), () => Promise.resolve(0));
    await s.greet(true);
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(/ollama\.com\/download/);
  });
});
