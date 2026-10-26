import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { addProvider, providerCatalog, testProvider } from '../../src/cli/chat-settings.js';
import { providersAddSmart, wantsSmartAdd } from '../../src/cli/commands/providers-add.js';
import type { CliIO } from '../../src/cli/io.js';
import { providerExtras } from '../../src/cli/provider-messages.js';
import {
  needsSetup,
  parseHeaders,
  probeProvider,
  setupProvider,
} from '../../src/cli/provider-setup.js';
import { loadConfig } from '../../src/config/load.js';
import { resolvePaths, userConfigFile } from '../../src/core/paths.js';
import { parseProviderArgs, runProviderCommand } from '../../src/tui/provider-command.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

type Handler = (url: string, headers: Headers, method: string) => Response | undefined;

/** An io whose fetch answers from `handler` (404 otherwise) and records every URL. */
async function io(handler: Handler = () => undefined): Promise<CliIO & { urls: string[] }> {
  const urls: string[] = [];
  const out = new PassThrough();
  return {
    stdout: out,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: await isolatedEnv({}),
    cwd: await makeRepo(),
    isTTY: false,
    urls,
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const res = handler(url, new Headers(init?.headers), init?.method ?? 'GET');
      return Promise.resolve(res ?? new Response('nope', { status: 404 }));
    },
  };
}

const list = (...ids: string[]): Response => Response.json({ data: ids.map((id) => ({ id })) });

async function configText(x: CliIO): Promise<string> {
  return readFile(userConfigFile(resolvePaths(x.env)), 'utf8');
}

describe('provider setup: catalog entries with templated URLs', () => {
  it('sets up Azure OpenAI from a resource name, with the api-key header', async () => {
    const x = await io((url, h) =>
      url === 'https://my-res.openai.azure.com/openai/v1/models' && h.get('api-key') === 'az-key'
        ? list('gpt-5-deploy')
        : undefined,
    );
    const r = await setupProvider(x, {
      provider: 'azure',
      key: 'az-key',
      fields: { resource: 'my-res' },
    });
    expect(r.probe).toMatchObject({ ok: true, models: ['gpt-5-deploy'] });
    expect(r.message).toMatch(/\/model azure:gpt-5-deploy/);
    const { config } = await loadConfig({ cwd: x.cwd, env: x.env });
    expect(config.providers.endpoints.azure).toMatchObject({
      kind: 'openai',
      auth: 'api-key',
      base_url: 'https://my-res.openai.azure.com/openai/v1',
    });
    expect(await configText(x)).not.toContain('az-key');
  });

  it('refuses a templated provider with a missing value', async () => {
    const x = await io();
    await expect(setupProvider(x, { provider: 'azure', key: 'k' })).rejects.toThrow(
      /needs resource name/,
    );
  });

  it('saves a provider that has no model list (Vertex)', async () => {
    const x = await io();
    const r = await setupProvider(x, { provider: 'vertex', key: 'tok', fields: { project: 'p' } });
    expect(r.probe).toMatchObject({ ok: true, models: [] });
    expect(x.urls).toEqual([]);
  });

  it('explains why a catalog provider failed: 401 key rejected', async () => {
    const x = await io(() => new Response('{}', { status: 401 }));
    await expect(
      setupProvider(x, { provider: 'cloudflare', key: 'bad', fields: { account: 'abc' } }),
    ).resolves.toMatchObject({ probe: { ok: true } });
    await expect(
      setupProvider(x, { provider: 'azure', key: 'bad', fields: { resource: 'r' } }),
    ).rejects.toThrow(/401: key rejected/);
  });
});

describe('provider setup: custom endpoints from a URL and key', () => {
  it('detects an Anthropic-compatible gateway and writes kind = anthropic', async () => {
    const x = await io((url, h) =>
      url === 'https://gw.example.com/anthropic/v1/models' && h.get('x-api-key') === 'k'
        ? Response.json({ data: [{ id: 'm-1', type: 'model' }], has_more: false })
        : undefined,
    );
    const r = await setupProvider(x, {
      provider: 'gw',
      url: 'https://gw.example.com/anthropic',
      key: 'k',
    });
    expect(r.probe.flavor).toBe('anthropic');
    const { config } = await loadConfig({ cwd: x.cwd, env: x.env });
    expect(config.providers.endpoints.gw).toMatchObject({
      kind: 'anthropic',
      base_url: 'https://gw.example.com/anthropic',
    });
  });

  it('corrects a missing /v1 and keeps extra headers', async () => {
    const x = await io((url, h) =>
      url === 'https://llm.example.com/v1/models' && h.get('x-team') === 'blue'
        ? list('a', 'b')
        : undefined,
    );
    await addProvider(x, {
      provider: 'corp',
      url: 'https://llm.example.com',
      key: 'k',
      headers: { 'x-team': 'blue' },
    });
    const { config } = await loadConfig({ cwd: x.cwd, env: x.env });
    expect(config.providers.endpoints.corp).toMatchObject({
      base_url: 'https://llm.example.com/v1',
      headers: { 'x-team': 'blue' },
    });
    // The settings Test button now uses the saved headers too.
    expect(await testProvider(x, 'corp')).toMatchObject({ ok: true, models: 2 });
  });

  it('saves keyEnv and probes with that key (never the value)', async () => {
    const x = await io((url, h) =>
      url === 'https://inception.example/v1/models' && h.get('authorization') === 'Bearer k1'
        ? list('mercury-3')
        : undefined,
    );
    x.env.MY_KEY = 'k1';
    const r = await setupProvider(x, {
      provider: 'inception',
      url: 'https://inception.example/v1',
      keyEnv: 'MY_KEY',
      flavor: 'openai-chat',
    });
    expect(r.message).toMatch(/key from \$MY_KEY/);
    expect(r.probe).toMatchObject({ ok: true, models: ['mercury-3'] });
    const { config } = await loadConfig({ cwd: x.cwd, env: x.env });
    expect(config.providers.endpoints.inception).toMatchObject({
      base_url: 'https://inception.example/v1',
      api_key_env: 'MY_KEY',
    });
    expect(await configText(x)).not.toContain('k1');
  });

  it('keeps --key-env on the providers add smart path (flavor forces it)', async () => {
    const x = await io((url, h) =>
      url === 'https://inception.example/v1/models' && h.get('authorization') === 'Bearer k1'
        ? list('mercury-3')
        : undefined,
    );
    x.env.MY_KEY = 'k1';
    expect(
      await providersAddSmart(x, 'inception', {
        baseUrl: 'https://inception.example/v1',
        keyEnv: 'MY_KEY',
        flavor: 'openai-chat',
      }),
    ).toBe(0);
    const { config } = await loadConfig({ cwd: x.cwd, env: x.env });
    expect(config.providers.endpoints.inception).toMatchObject({ api_key_env: 'MY_KEY' });
  });

  it('does not save a remote endpoint that fails, and says why', async () => {
    const x = await io();
    await expect(
      addProvider(x, { provider: 'bad', url: 'https://bad.example.com/api', key: 'k' }),
    ).rejects.toThrow(/404: nothing at .*probably needs \/v1/);
    const { config } = await loadConfig({ cwd: x.cwd, env: x.env });
    expect(config.providers.endpoints.bad).toBeUndefined();
  });

  it('probes without saving (the Test button)', async () => {
    const x = await io(() => new Response('{}', { status: 401 }));
    const r = await probeProvider(x, { url: 'https://h.example.com/v1', key: 'nope' });
    expect(r.detail).toMatch(/^401: key rejected/);
  });

  it('routes only templated, custom-remote or extra-option requests through setup', () => {
    expect(needsSetup({ provider: 'groq', key: 'k' })).toBe(false);
    expect(needsSetup({ provider: 'mybox', url: 'http://localhost:1/v1' })).toBe(false);
    expect(needsSetup({ provider: 'azure' })).toBe(true);
    expect(needsSetup({ url: 'https://x.example/v1' })).toBe(true);
    expect(needsSetup({ provider: 'groq', flavor: 'openai-responses' })).toBe(true);
  });

  it('parses header lines and rejects bad ones', () => {
    expect(parseHeaders(['X-A: 1', 'b=2'])).toEqual({ 'X-A': '1', b: '2' });
    expect(() => parseHeaders(['nonsense'])).toThrow(/not a header/);
    expect(() => parseHeaders(['bad name: 1'])).toThrow(/not a usable header name/);
  });
});

describe('provider setup: settings messages, CLI and TUI', () => {
  it('the settings catalog carries fields and notes for the gallery form', () => {
    const azure = providerCatalog().find((c) => c.name === 'azure');
    expect(azure?.fields?.[0]).toMatchObject({ key: 'resource' });
    expect(azure?.note).toMatch(/deployment/);
  });

  it('drops malformed extras from a webview message', () => {
    expect(
      providerExtras({ fields: { resource: 'r', bad: 3 }, headers: 'x', flavor: 'anthropic' }),
    ).toEqual({ fields: { resource: 'r' }, flavor: 'anthropic' });
    expect(providerExtras({ flavor: 'cobol', fields: [] })).toEqual({});
  });

  it('omnexx providers add takes --field and --header and detects the flavor', async () => {
    expect(wantsSmartAdd('azure', {})).toBe(true);
    expect(wantsSmartAdd('groq', {})).toBe(false);
    expect(wantsSmartAdd('x', { header: ['a: b'] })).toBe(true);
    const x = await io((url) => (url.endsWith('/openai/v1/models') ? list('d1') : undefined));
    const code = await providersAddSmart(x, 'azure-foundry', {
      key: 'k',
      field: ['resource=fdry'],
    });
    expect(code).toBe(0);
    expect(x.urls[0]).toBe('https://fdry.services.ai.azure.com/openai/v1/models');
    await expect(providersAddSmart(x, 'y', { flavor: 'cobol' })).rejects.toThrow(/unknown flavor/);
    await expect(providersAddSmart(x, 'azure', { field: ['oops'] })).rejects.toThrow(/name=value/);
  });

  it('/provider lists the catalog, parses words, and tests without saving', async () => {
    const x = await io((url) =>
      url === 'https://h.example.com/v1/models' ? list('z') : undefined,
    );
    expect(await runProviderCommand(x, [])).toMatch(/hosted: .*azure \(resource\)/);
    expect(
      parseProviderArgs(['azure', 'KEY', 'resource=r', '--header', 'X-A:1', '--flavor', 'gemini']),
    ).toEqual({
      provider: 'azure',
      key: 'KEY',
      fields: { resource: 'r' },
      headers: { 'X-A': '1' },
      flavor: 'gemini',
    });
    expect(() => parseProviderArgs(['--flavor', 'x'])).toThrow(/--flavor/);
    expect(await runProviderCommand(x, ['test', 'https://h.example.com/v1', 'k'])).toMatch(
      /^✓ OpenAI-compatible: 1 models/,
    );
    expect(await runProviderCommand(x, ['https://h.example.com/v1', 'k'])).toMatch(/added example/);
  });
});
