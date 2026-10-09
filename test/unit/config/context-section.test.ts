import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { ConfigError } from '../../../src/errors.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

async function load(project: string) {
  const cwd = await tempDir();
  await writeFile(join(cwd, 'omnexx.toml'), project);
  const env = await isolatedEnv();
  return loadConfig({ cwd, env });
}

describe('[context] config section', () => {
  it('defaults min_clear_tokens to 4000', async () => {
    const { config } = await load('');
    expect(config.context.min_clear_tokens).toBe(4_000);
  });

  it('parses a TOML-set value', async () => {
    const { config } = await load('[context]\nmin_clear_tokens = 2048\n');
    expect(config.context.min_clear_tokens).toBe(2_048);
  });

  it('rejects non-positive and non-integer values', async () => {
    await expect(load('[context]\nmin_clear_tokens = 0\n')).rejects.toThrow(
      /context.min_clear_tokens/,
    );
    await expect(load('[context]\nmin_clear_tokens = 0\n')).rejects.toThrow(ConfigError);
    await expect(load('[context]\nmin_clear_tokens = -5\n')).rejects.toThrow(
      /context.min_clear_tokens/,
    );
    await expect(load('[context]\nmin_clear_tokens = 1.5\n')).rejects.toThrow(
      /context.min_clear_tokens/,
    );
  });

  it('rejects unknown keys', async () => {
    await expect(load('[context]\nmin_clear_token = 1\n')).rejects.toThrow(/unknown key/);
  });
});
