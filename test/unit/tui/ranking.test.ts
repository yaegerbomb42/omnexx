import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { readRanking, writeRanking } from '../../../src/config/ranking.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('/models ranking', () => {
  it('#1 becomes chat, and the list is every role’s failover order', async () => {
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    await writeRanking(paths, ['anthropic:opus', 'anthropic:sonnet', 'not a ref']);
    expect(await readRanking(paths)).toEqual(['anthropic:opus', 'anthropic:sonnet']);
    const { config } = await loadConfig({ cwd: await tempDir(), env });
    expect(config.models.chat).toBe('anthropic:opus');
    expect(config.models.worker).toEqual(['anthropic:opus', 'anthropic:sonnet']);
    expect(config.models.planner).toEqual(['anthropic:opus', 'anthropic:sonnet']);
    // Flags (and a project's omnexx.toml) still win.
    const flagged = await loadConfig({
      cwd: await tempDir(),
      env,
      flags: { models: { worker: 'anthropic:haiku' } },
    });
    expect(flagged.config.models.worker).toBe('anthropic:haiku');
  });

  it('no ranking file: nothing changes', async () => {
    const env = await isolatedEnv();
    expect(await readRanking(resolvePaths(env))).toEqual([]);
    const { config } = await loadConfig({ cwd: await tempDir(), env });
    expect(config.models.chat).toBeUndefined();
  });
});
