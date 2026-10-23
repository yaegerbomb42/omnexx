import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../../../src/config/load.js';
import { isWorkMode, workModeOf } from '../../../src/config/work-mode.js';
import { flagsToConfig } from '../../../src/cli/commands/run.js';
import { UsageError } from '../../../src/errors.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

async function setup(project?: string, user?: string) {
  const cwd = await tempDir();
  const env = await isolatedEnv();
  if (project !== undefined) await writeFile(join(cwd, 'omnexx.toml'), project);
  if (user !== undefined) {
    await mkdir(String(env.OMNEXX_CONFIG_HOME), { recursive: true });
    await writeFile(join(String(env.OMNEXX_CONFIG_HOME), 'config.toml'), user);
  }
  return { cwd, env };
}

describe('work domain config', () => {
  it('defaults to swe when nothing sets a domain', async () => {
    const { cwd, env } = await setup();
    const { config } = await loadConfig({ cwd, env });
    expect(config.execution.domain).toBe('swe');
    expect(workModeOf(config)).toBe('swe');
    expect(defaultConfig().execution.domain).toBe('swe');
  });

  it('reads [execution] domain from the project file, over the user file', async () => {
    const { cwd, env } = await setup(
      '[execution]\ndomain = "general"\n',
      '[execution]\ndomain = "swe"\n',
    );
    const { config } = await loadConfig({ cwd, env });
    expect(config.execution.domain).toBe('general');
  });

  it('OMNEXX_EXECUTION_DOMAIN beats the project file', async () => {
    const { cwd, env } = await setup('[execution]\ndomain = "general"\n');
    env.OMNEXX_EXECUTION_DOMAIN = 'swe';
    const { config } = await loadConfig({ cwd, env });
    expect(config.execution.domain).toBe('swe');
  });

  it('a flag beats the env var', async () => {
    const { cwd, env } = await setup();
    env.OMNEXX_EXECUTION_DOMAIN = 'swe';
    const { config } = await loadConfig({
      cwd,
      env,
      flags: { execution: { domain: 'general' } },
    });
    expect(config.execution.domain).toBe('general');
  });

  it('an unknown domain in omnexx.toml is a config error naming the key', async () => {
    const { cwd, env } = await setup('[execution]\ndomain = "docs"\n');
    await expect(loadConfig({ cwd, env })).rejects.toThrow(/execution\.domain/);
  });

  it('an unknown OMNEXX_EXECUTION_DOMAIN is a config error too', async () => {
    const { cwd, env } = await setup();
    env.OMNEXX_EXECUTION_DOMAIN = 'docs';
    await expect(loadConfig({ cwd, env })).rejects.toThrow(/execution\.domain/);
  });

  it('is independent of the execution posture: domain and mode coexist', async () => {
    const { cwd, env } = await setup('[execution]\nmode = "efficient"\ndomain = "general"\n');
    const { config } = await loadConfig({ cwd, env });
    expect(config.execution.mode).toBe('efficient');
    expect(config.execution.domain).toBe('general');
  });
});

describe('--mode flag', () => {
  it('maps to the [execution] domain layer', () => {
    expect(flagsToConfig({ mode: 'general' })).toEqual({ execution: { domain: 'general' } });
    expect(flagsToConfig({ mode: 'swe' })).toEqual({ execution: { domain: 'swe' } });
    expect(flagsToConfig({})).not.toHaveProperty('execution');
  });

  it('rejects an unknown mode', () => {
    expect(() => flagsToConfig({ mode: 'docs' })).toThrow(UsageError);
  });
});

describe('isWorkMode', () => {
  it('accepts exactly swe and general', () => {
    expect(isWorkMode('swe')).toBe(true);
    expect(isWorkMode('general')).toBe(true);
    expect(isWorkMode('normal')).toBe(false);
    expect(isWorkMode(undefined)).toBe(false);
  });
});
