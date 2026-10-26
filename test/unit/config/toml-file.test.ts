import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upsertTomlKeys, upsertTomlTable } from '../../../src/config/toml-file.js';
import { tempDir } from '../../support/tmp.js';

describe('upsertTomlTable', () => {
  it('creates the file with one table', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.toml');
    await upsertTomlTable(file, 'pool', { ranked: ['groq:a', 'openrouter:b'], mode: 'fallback' });
    const text = await readFile(file, 'utf8');
    expect(text).toContain('[pool]');
    expect(text).toContain('ranked = [ "groq:a", "openrouter:b" ]');
  });

  it('replaces a table and its subtables, keeping comments and other tables', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.toml');
    const before = [
      '# my providers, hand-tuned',
      '[providers.endpoints.groq]',
      'base_url = "https://api.groq.com/openai/v1"',
      'api_key_env = "GROQ_API_KEY"',
      '',
      '[roles]',
      'spread_helpers = false',
      '',
      '[roles.models]',
      'planner = [ "old:one" ]',
      '',
      '[budget]',
      'max_usd = 50',
      '',
    ].join('\n');
    await writeFile(file, before);
    await upsertTomlTable(file, 'roles', {
      spread_helpers: true,
      models: { planner: ['openrouter:big'] },
      strategies: {},
    });
    const after = await readFile(file, 'utf8');
    expect(after).toContain('# my providers, hand-tuned');
    expect(after).toContain('[providers.endpoints.groq]');
    expect(after).toContain('api_key_env = "GROQ_API_KEY"');
    expect(after).toContain('[budget]');
    expect(after).toContain('max_usd = 50');
    expect(after).not.toContain('old:one');
    expect(after).toContain('planner = [ "openrouter:big" ]');
    expect(after).toContain('spread_helpers = true');
  });

  it('appends a missing table at the end', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.toml');
    await writeFile(file, '[budget]\nmax_usd = 25\n');
    await upsertTomlTable(file, 'pool', { ranked: ['a:b'], mode: 'priority' });
    const after = await readFile(file, 'utf8');
    expect(after.indexOf('[budget]')).toBeLessThan(after.indexOf('[pool]'));
    expect(after).toContain('mode = "priority"');
  });
});

describe('upsertTomlKeys', () => {
  it('replaces a top-level key in place and inserts a missing one before the first table', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.toml');
    await writeFile(file, '# header\nmodel = "old:model"\n\n[budget]\nmax_usd = 25\n');
    await upsertTomlKeys(file, { model: 'groq:new', provider: 'groq' });
    const after = await readFile(file, 'utf8');
    expect(after).toContain('# header');
    expect(after).toContain('model = "groq:new"');
    expect(after).toContain('provider = "groq"');
    expect(after.indexOf('provider = "groq"')).toBeLessThan(after.indexOf('[budget]'));
    expect(after).toContain('[budget]');
  });
});
