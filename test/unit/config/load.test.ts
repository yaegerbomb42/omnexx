import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../../../src/config/load.js';
import { ConfigError } from '../../../src/errors.js';
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

describe('config precedence', () => {
  it('uses the 24 h defaults when nothing is set', async () => {
    const { cwd, env } = await setup();
    const { config, files } = await loadConfig({ cwd, env });
    expect(files).toEqual([]);
    expect(config.budget).toMatchObject({
      max_usd: 50,
      max_hours: 24,
      max_cycles: 300,
      wrapup_reserve: 0.08,
    });
    expect(config.judge.kind).toBe('none');
    expect(config.workers.max_concurrent).toBe(1);
  });

  it('flags > env > project > user > defaults', async () => {
    const { cwd, env } = await setup(
      '[budget]\nmax_usd = 30\nmax_hours = 10\nmax_cycles = 20\n',
      '[budget]\nmax_usd = 20\nmax_hours = 5\nmax_cycles = 10\nmax_turns_per_cycle = 7\n',
    );
    env.OMNEXX_BUDGET_MAX_USD = '40';
    env.OMNEXX_BUDGET_MAX_HOURS = '12';
    const { config, files } = await loadConfig({ cwd, env, flags: { budget: { max_usd: 99 } } });
    expect(config.budget.max_usd).toBe(99); // flag
    expect(config.budget.max_hours).toBe(12); // env
    expect(config.budget.max_cycles).toBe(20); // project
    expect(config.budget.max_turns_per_cycle).toBe(7); // user
    expect(config.budget.warn_at).toBe(0.8); // default
    expect(files).toHaveLength(2);
  });

  it('arrays from a higher layer replace, not concatenate', async () => {
    const { cwd, env } = await setup('setup = ["a"]\n', 'setup = ["b", "c"]\n');
    const { config } = await loadConfig({ cwd, env });
    expect(config.setup).toEqual(['a']);
  });
});

describe('config errors are one actionable line', () => {
  const cases: [string | undefined, string | undefined, RegExp][] = [
    ['[budget]\nmax_usd = -1\n', undefined, /omnexx\.toml: budget\.max_usd: .*/],
    ['[budgett]\nmax_usd = 1\n', undefined, /omnexx\.toml: \(root\)|budgett/],
    [
      '[[gates]]\nname = "t"\nrun = "x"\ntimeout = "soon"\n',
      undefined,
      /gates\[0\]\.timeout: expected a duration/,
    ],
    ['sandbox = "vm"\n', undefined, /sandbox/],
    [undefined, '[judge]\nkind = "oracle"\n', /config\.toml: judge\.kind/],
  ];
  it.each(cases)('rejects %j', async (project, user, re) => {
    const { cwd, env } = await setup(project, user);
    const err = await loadConfig({ cwd, env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const line = (err as ConfigError).oneLine();
    expect(line).not.toContain('\n');
    expect(line).toMatch(re);
    expect(line).toMatch(/docs\/config\.md/);
  });

  it('reports TOML syntax errors with file and line', async () => {
    const { cwd, env } = await setup('setup = [\n');
    const err = (await loadConfig({ cwd, env }).catch((e: unknown) => e)) as ConfigError;
    expect(err.message).toMatch(/omnexx\.toml:\d+:\d+/);
  });

  it('rejects a non-numeric env override by name', async () => {
    const { cwd, env } = await setup();
    env.OMNEXX_BUDGET_MAX_USD = 'lots';
    await expect(loadConfig({ cwd, env })).rejects.toThrow(
      /OMNEXX_BUDGET_MAX_USD: expected a number/,
    );
  });
});

describe('workers config', () => {
  it('accepts unknown worker ids, all off by default', async () => {
    const { cwd, env } = await setup('[workers.aider]\ntimeout = "15m"\n[workers.someday-tool]\n');
    const { config } = await loadConfig({ cwd, env });
    expect(config.workers.backends.aider?.enabled).toBe(false);
    expect(config.workers.backends['someday-tool']?.enabled).toBe(false);
    expect(config.workers.priority[0]).toBe('aider');
  });

  it('validates worker tables strictly', async () => {
    const { cwd, env } = await setup('[workers.aider]\nenabld = true\n');
    await expect(loadConfig({ cwd, env })).rejects.toThrow(/workers\.aider/);
  });

  it('defaultConfig needs no files', () => {
    expect(defaultConfig().protected).toContain('omnexx.toml');
  });
});
