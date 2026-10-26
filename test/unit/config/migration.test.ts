import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

/**
 * The 9-provider shape: nine OpenAI-compatible endpoints, each with a primary key env var
 * and a rotation list (api_key_envs) of two more. The values are fake; only the names and
 * the order matter. Migration must not lose or reorder a single key env.
 */
const PROVIDERS = [
  'groq',
  'cerebras',
  'openrouter',
  'deepseek',
  'xai',
  'mistral',
  'nvidia',
  'together',
  'fireworks',
] as const;

function endpointToml(name: string): string {
  const up = name.toUpperCase();
  return [
    `[providers.endpoints.${name}]`,
    `base_url = "https://api.${name}.example/v1"`,
    `api_key_env = "${up}_API_KEY"`,
    `api_key_envs = [ "${up}_API_KEY_2", "${up}_API_KEY_3" ]`,
    '',
  ].join('\n');
}

async function setupFixture(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await tempDir('migrate-');
  const env = await isolatedEnv();
  const configHome = String(env.OMNEXX_CONFIG_HOME);
  await mkdir(configHome, { recursive: true });
  const configToml = [
    '# hand-tuned providers; comments must survive migration',
    ...PROVIDERS.map(endpointToml),
    '[budget]',
    'max_usd = 75',
    '',
  ].join('\n');
  await writeFile(join(configHome, 'config.toml'), configToml);
  await writeFile(
    join(configHome, 'roles.json'),
    JSON.stringify(
      {
        version: 2,
        models: { planner: ['openrouter:big-one', 'groq:fast-one'], worker: ['groq:work-one'] },
        strategies: { planner: 'priority' },
        spreadHelpers: false,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(configHome, 'models.json'),
    JSON.stringify(
      {
        ranked: ['groq:pool-a', 'cerebras:pool-b', 'openrouter:pool-c'],
        mode: 'fallback',
      },
      null,
      2,
    ),
  );
  // Key material (fake values) for the rotation-order check.
  for (const name of PROVIDERS) {
    const up = name.toUpperCase();
    env[`${up}_API_KEY`] = `${name}-key-1`;
    env[`${up}_API_KEY_2`] = `${name}-key-2`;
    env[`${up}_API_KEY_3`] = `${name}-key-3`;
  }
  return { cwd, env };
}

/** The ordered key list run-deps assembles for one endpoint from a loaded config. */
function rotationKeys(
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  name: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const ep = config.providers.endpoints[name];
  if (!ep) return [];
  const primary = ep.api_key_env ? env[ep.api_key_env]?.trim() : undefined;
  const extra = (ep.api_key_envs ?? []).flatMap((n) => {
    const k = env[n]?.trim();
    return k && k !== primary ? [k] : [];
  });
  return [...new Set([...(primary ? [primary] : []), ...extra])];
}

describe('legacy config migration', () => {
  it('folds roles.json + models.json into config.toml and keeps all 9 providers rotating', async () => {
    const { cwd, env } = await setupFixture();
    const { config } = await loadConfig({ cwd, env });

    // Every provider survived, with its rotation list in the original order.
    expect(Object.keys(config.providers.endpoints).sort()).toEqual([...PROVIDERS].sort());
    for (const name of PROVIDERS) {
      const up = name.toUpperCase();
      const ep = config.providers.endpoints[name];
      expect(ep?.api_key_env).toBe(`${up}_API_KEY`);
      expect(ep?.api_key_envs).toEqual([`${up}_API_KEY_2`, `${up}_API_KEY_3`]);
      expect(rotationKeys(config, name, env)).toEqual([
        `${name}-key-1`,
        `${name}-key-2`,
        `${name}-key-3`,
      ]);
    }
    expect(config.budget.max_usd).toBe(75);

    // The pool and the per-role lists came through, roles above pool.
    expect(config.models.planner).toEqual(['openrouter:big-one', 'groq:fast-one']);
    expect(config.models.worker).toEqual(['groq:work-one']);
    expect(config.models.cheap).toEqual(['groq:pool-a', 'cerebras:pool-b', 'openrouter:pool-c']);
    expect(config.models.chat).toEqual(['groq:pool-a', 'cerebras:pool-b', 'openrouter:pool-c']);
    expect(config.models.spread_helpers).toBe(false);

    // The unified file now holds both tables, and the hand-written comment survived.
    const toml = await readFile(join(String(env.OMNEXX_CONFIG_HOME), 'config.toml'), 'utf8');
    expect(toml).toContain('# hand-tuned providers; comments must survive migration');
    expect(toml).toContain('[pool]');
    expect(toml).toContain('[roles]');
    expect(toml).toContain('openrouter:big-one');

    // The old files are renamed, not deleted outright.
    await expect(access(join(String(env.OMNEXX_CONFIG_HOME), 'roles.json'))).rejects.toThrow();
    await expect(access(join(String(env.OMNEXX_CONFIG_HOME), 'models.json'))).rejects.toThrow();
    await access(join(String(env.OMNEXX_CONFIG_HOME), 'roles.json.migrated'));
    await access(join(String(env.OMNEXX_CONFIG_HOME), 'models.json.migrated'));

    // A second load reads the same values from the unified file alone.
    const again = await loadConfig({ cwd, env });
    expect(again.config.models.planner).toEqual(['openrouter:big-one', 'groq:fast-one']);
    expect(again.config.models.cheap).toEqual([
      'groq:pool-a',
      'cerebras:pool-b',
      'openrouter:pool-c',
    ]);
    for (const name of PROVIDERS) {
      expect(rotationKeys(again.config, name, env)).toEqual([
        `${name}-key-1`,
        `${name}-key-2`,
        `${name}-key-3`,
      ]);
    }
    expect(again.config.providers.endpoints.groq?.api_key_envs).toEqual([
      'GROQ_API_KEY_2',
      'GROQ_API_KEY_3',
    ]);
  });

  it('leaves a [pool] already in config.toml alone when the old file disagrees', async () => {
    const { cwd, env } = await setupFixture();
    const configHome = String(env.OMNEXX_CONFIG_HOME);
    const toml = await readFile(join(configHome, 'config.toml'), 'utf8');
    await writeFile(
      join(configHome, 'config.toml'),
      `${toml}[pool]\nranked = [ "xai:mine" ]\nmode = "priority"\n`,
    );
    const { config } = await loadConfig({ cwd, env });
    expect(config.models.cheap).toEqual(['xai:mine']);
    // The legacy file was still retired so it cannot shadow the new file later.
    await expect(access(join(configHome, 'models.json'))).rejects.toThrow();
  });

  it('maps a top-level `model` to every role the pool leaves unset', async () => {
    const cwd = await tempDir('migrate-model-');
    const env = await isolatedEnv();
    const configHome = String(env.OMNEXX_CONFIG_HOME);
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, 'config.toml'), 'model = "groq:only-one"\n');
    const { config } = await loadConfig({ cwd, env });
    expect(config.models.chat).toEqual(['groq:only-one']);
    expect(config.models.worker).toEqual(['groq:only-one']);
    expect(config.model).toBe('groq:only-one');
  });
});
