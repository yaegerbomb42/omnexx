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

describe('/models picker', () => {
  it('ticking the last model then enter adds the ticked models, not the "+ add" action below', async () => {
    const { PassThrough } = await import('node:stream');
    const { Session } = await import('../../../src/tui/session.js');
    const env = await isolatedEnv();
    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: await tempDir(),
      isTTY: false,
    } as never;
    const s = new Session(io, () => Promise.resolve(0));
    (s as unknown as { pickFor: string }).pickFor = 'rank';
    s.modelPicker = {
      items: [
        { kind: 'model', ref: 'pool:a', provider: 'pool', model: 'a' },
        { kind: 'model', ref: 'pool:b', provider: 'pool', model: 'b' },
        { kind: 'add-env', label: '+ use the keys in your environment' },
      ],
      query: '',
      cursor: 1,
      current: undefined,
      unreachable: [],
      checked: new Set<string>(),
    };
    s.pickerKey({ toggle: true });
    expect(s.modelPicker.cursor).toBe(1);
    s.pickerKey({ up: true });
    s.pickerKey({ toggle: true });
    s.pickerKey({ down: true });
    s.pickerKey({ down: true });
    s.pickerKey({ enter: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(await readRanking(resolvePaths(env))).toEqual(['pool:b', 'pool:a']);
    expect(s.rankView?.ranked).toEqual(['pool:b', 'pool:a']);
  });
});
