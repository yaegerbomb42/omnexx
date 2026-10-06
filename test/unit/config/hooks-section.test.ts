import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, type LoadedConfig } from '../../../src/config/load.js';
import { ConfigError } from '../../../src/errors.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

async function load(project: string): Promise<LoadedConfig> {
  const cwd = await tempDir();
  await writeFile(join(cwd, 'omnexx.toml'), project);
  const env = await isolatedEnv();
  return loadConfig({ cwd, env });
}

describe('[[hooks]] config section', () => {
  it('defaults to no hooks', async () => {
    const { config } = await load('');
    expect(config.hooks).toEqual([]);
  });

  it('parses [[hooks]] tables in file order with defaults', async () => {
    const { config } = await load(
      [
        '[[hooks]]',
        'on = "pre_commit"',
        'run = "gitleaks"',
        '',
        '[[hooks]]',
        'on = "pre_tool"',
        'run = "lint"',
        'match = "edit*"',
        'timeout = "5s"',
        '',
      ].join('\n'),
    );
    expect(config.hooks).toEqual([
      { on: 'pre_commit', run: 'gitleaks', timeout: '30s' },
      { on: 'pre_tool', run: 'lint', match: 'edit*', timeout: '5s' },
    ]);
  });

  it('rejects an unknown hook event', async () => {
    await expect(load('[[hooks]]\non = "pre_push"\nrun = "x"\n')).rejects.toThrow(/hooks\[0\]\.on/);
    await expect(load('[[hooks]]\non = "pre_push"\nrun = "x"\n')).rejects.toThrow(ConfigError);
  });

  it('rejects a typo inside a hook table', async () => {
    await expect(load('[[hooks]]\non = "run_end"\nrun = "x"\ntimout = "5s"\n')).rejects.toThrow(
      /unknown key/,
    );
  });

  it('rejects a bad timeout duration', async () => {
    await expect(load('[[hooks]]\non = "run_end"\nrun = "x"\ntimeout = "soon"\n')).rejects.toThrow(
      /duration/,
    );
  });
});
