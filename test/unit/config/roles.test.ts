import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { writeRanking } from '../../../src/config/ranking.js';
import { parseRoles, readRoles, rolesLayer, writeRoles } from '../../../src/config/roles.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('model roles', () => {
  it('keeps only well-formed, distinct refs per known role', () => {
    const r = parseRoles({
      models: {
        worker: ['groq:llama-4', 'groq:llama-4', 'bad ref', 7, 'openrouter:deepseek/v4'],
        helpers: [],
        nonsense: ['groq:x'],
      },
      spreadHelpers: false,
    });
    expect(r).toEqual({
      models: { worker: ['groq:llama-4', 'openrouter:deepseek/v4'] },
      strategies: {},
      spreadHelpers: false,
    });
    expect(parseRoles(null)).toEqual({ models: {}, strategies: {}, spreadHelpers: true });
    expect(
      parseRoles({ models: {}, strategies: { helpers: 'least-busy', worker: 'loud' } }).strategies,
    ).toEqual({ helpers: 'least-busy' });
  });

  it('becomes a config layer with only the roles that were set', () => {
    expect(rolesLayer({ models: {}, strategies: {}, spreadHelpers: true })).toBeUndefined();
    expect(
      rolesLayer({
        models: { chat: ['ollama:qwen', 'groq:x'], helpers: ['groq:x', 'cerebras:y'] },
        strategies: { helpers: 'random' },
        spreadHelpers: false,
      }),
    ).toEqual({
      models: {
        chat: 'ollama:qwen',
        helpers: ['groq:x', 'cerebras:y'],
        spread_helpers: false,
        routing: { helpers: 'random' },
      },
    });
  });

  it('loads above the /models pool and below the project omnexx.toml', async () => {
    const env = await isolatedEnv({});
    const cwd = await tempDir('roles-');
    const paths = resolvePaths(env);
    await writeRanking(paths, ['groq:pool-a', 'cerebras:pool-b']);
    await writeRoles(paths, {
      models: { planner: ['openrouter:big'], helpers: ['groq:h1', 'cerebras:h2'] },
      strategies: {},
      spreadHelpers: true,
    });
    expect((await readRoles(paths)).models.planner).toEqual(['openrouter:big']);

    let { config } = await loadConfig({ cwd, env });
    expect(config.models.planner).toEqual(['openrouter:big']);
    expect(config.models.helpers).toEqual(['groq:h1', 'cerebras:h2']);
    expect(config.models.worker).toEqual(['groq:pool-a', 'cerebras:pool-b']);
    expect(config.models.spread_helpers).toBe(true);

    await writeFile(join(cwd, 'omnexx.toml'), '[models]\nplanner = "anthropic:opus"\n');
    ({ config } = await loadConfig({ cwd, env }));
    expect(config.models.planner).toBe('anthropic:opus');
  });
});
