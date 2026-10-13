import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  addProvider,
  browserSettings,
  parseBrowserSettings,
  providerCatalog,
  providerSettings,
  removeProvider,
  setBrowserSettings,
  testProvider,
} from '../../src/cli/chat-settings.js';
import type { CliIO } from '../../src/cli/io.js';
import { resolvePaths, userConfigFile } from '../../src/core/paths.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

async function io(): Promise<CliIO> {
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: await isolatedEnv({}),
    cwd: await makeRepo(),
    isTTY: false,
    fetch: () => Promise.reject(new Error('no network in tests')),
  };
}

describe('chat settings: providers for the panel', () => {
  it('lists Anthropic, hosted and local providers with where to get keys', () => {
    const catalog = providerCatalog();
    const byName = new Map(catalog.map((c) => [c.name, c]));
    expect(catalog[0]?.name).toBe('anthropic');
    expect(byName.get('openrouter')).toMatchObject({ local: false, keyPrefix: 'sk-or-' });
    expect(byName.get('openrouter')?.signup).toMatch(/^https:\/\//);
    expect(byName.get('ollama')).toMatchObject({ local: true });
    expect(byName.has('custom')).toBe(false);
  });

  it('adds a provider with a key, shows it masked, and removes it with its key', async () => {
    const x = await io();
    expect((await providerSettings(x)).connected).toEqual([]);

    const key = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
    await addProvider(x, { provider: 'groq', key });
    const after = await providerSettings(x);
    const groq = after.connected.find((p) => p.name === 'groq');
    expect(groq).toMatchObject({ label: 'Groq', local: false, keySource: 'credentials file' });
    expect(groq?.key).not.toContain('abcdefghijklmnop');
    expect(groq?.key).toMatch(/…6789$/);

    expect(await removeProvider(x, 'groq')).toMatch(/removed groq and its stored key/);
    expect((await providerSettings(x)).connected.some((p) => p.name === 'groq')).toBe(false);
    expect(await removeProvider(x, 'groq')).toMatch(/nothing to remove/);
  });

  it('adds a local server by URL under a chosen name, and an Anthropic key', async () => {
    const x = await io();
    await addProvider(x, { provider: 'mybox', url: 'http://localhost:9999/v1' });
    await addProvider(x, { provider: 'anthropic', key: 'sk-ant-test-0000000000000000000000' });
    const s = await providerSettings(x);
    expect(s.connected.find((p) => p.name === 'mybox')).toMatchObject({
      baseUrl: 'http://localhost:9999/v1',
      local: true,
      key: null,
    });
    expect(s.connected.find((p) => p.name === 'anthropic')?.key).toMatch(/^sk-ant-…/);
  });

  it('refuses bad input before touching any file', async () => {
    const x = await io();
    await expect(addProvider(x, {})).rejects.toThrow(/pick a provider/);
    await expect(addProvider(x, { url: 'ftp://x' })).rejects.toThrow(/http/);
    await expect(addProvider(x, { provider: 'Bad Name!' })).rejects.toThrow(/not a usable name/);
    await expect(removeProvider(x, '../etc')).rejects.toThrow(/not a provider name/);
  });

  it('tests a provider by listing its models with the stored key', async () => {
    const x = await io();
    await addProvider(x, { provider: 'groq', key: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789' });
    const seen: string[] = [];
    const ok: CliIO = {
      ...x,
      fetch: (url, init) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        seen.push(`${href} ${new Headers(init?.headers).get('authorization') ?? ''}`);
        return Promise.resolve(Response.json({ data: [{ id: 'llama-4' }, { id: 'qwen-3' }] }));
      },
    };
    expect(await testProvider(ok, 'groq')).toMatchObject({ ok: true, models: 2 });
    expect(seen[0]).toMatch(/api\.groq\.com.*\/models Bearer gsk_/);
    expect(await testProvider(x, 'groq')).toMatchObject({ ok: false, models: 0 });
    expect(await testProvider(x, 'nope')).toMatchObject({ ok: false, detail: 'not set up' });
    expect(await testProvider(x, 'anthropic')).toMatchObject({ ok: false, detail: 'no key set' });
  });
});

describe('chat settings: the browser tool', () => {
  it('reads the schema defaults when nothing is set', async () => {
    expect(await browserSettings(await io())).toEqual({
      engine: 'chromium',
      profile: null,
      sessionName: null,
      headless: true,
    });
  });

  it('saves to the user config.toml, keeps other [browser] keys and comments, and unsets empties', async () => {
    const x = await io();
    const file = userConfigFile(resolvePaths(x.env));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '# mine\n[browser]\nenabled = true\nallow = ["example.com"]\n');

    await setBrowserSettings(x, {
      engine: 'camoufox',
      profile: '  /tmp/profile  ',
      sessionName: 'work',
      headless: false,
    });
    expect(await browserSettings(x)).toEqual({
      engine: 'camoufox',
      profile: '/tmp/profile',
      sessionName: 'work',
      headless: false,
    });
    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('# mine');
    expect(saved).toContain('enabled = true');
    expect(saved).toContain('allow = ["example.com"]');

    await setBrowserSettings(x, {
      engine: 'chromium',
      profile: '',
      sessionName: ' ',
      headless: true,
    });
    expect(await browserSettings(x)).toMatchObject({ profile: null, sessionName: null });
    expect(await readFile(file, 'utf8')).not.toMatch(/profile|session_name/);
  });

  it('rejects a bad engine, control characters and an unusable session name', () => {
    expect(() => parseBrowserSettings({ engine: 'firefox' })).toThrow(/chromium or camoufox/);
    expect(() => parseBrowserSettings({ profile: 'a\nb' })).toThrow(/control characters/);
    expect(() => parseBrowserSettings({ sessionName: 'a\u0007' })).toThrow(/control characters/);
    expect(() => parseBrowserSettings({ sessionName: 'has space' })).toThrow(/session name/);
    expect(() => parseBrowserSettings({ headless: 'yes' })).toThrow(/on or off/);
    expect(() => parseBrowserSettings({ profile: 42 })).toThrow(/must be text/);
  });
});
