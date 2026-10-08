import { describe, expect, it } from 'vitest';
import { findKeyInText } from '../../../src/cli/connect.js';
import {
  dailyShuffle,
  rankingLayer,
  readPoolMode,
  readRanking,
  writePoolMode,
  writeRanking,
} from '../../../src/config/ranking.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { EXHAUSTED_FOR_MS, QuotaLedger } from '../../../src/providers/quota-ledger.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('quota ledger', () => {
  it('marks a model, shares it through the file, and forgets it after the reset window', async () => {
    let t = 1_000;
    const file = `${await tempDir()}/quota.json`;
    const a = new QuotaLedger(file, () => t);
    a.mark('groq:llama');
    expect(new QuotaLedger(file, () => t).exhaustedAt('groq:llama')).toBe(1_000);
    expect(a.exhaustedAt('groq:other')).toBeUndefined();
    t += EXHAUSTED_FOR_MS;
    expect(a.exhaustedAt('groq:llama')).toBeUndefined();
  });
});

describe('model pool', () => {
  it('holds many models and remembers the order mode', async () => {
    const paths = resolvePaths(await isolatedEnv());
    const refs = Array.from({ length: 20 }, (_, i) => `pool:m${i}`);
    await writeRanking(paths, refs);
    await writePoolMode(paths, 'random');
    expect(await readRanking(paths)).toEqual(refs);
    expect(await readPoolMode(paths)).toBe('random');
    await writeRanking(paths, refs.slice(0, 3));
    expect(await readPoolMode(paths)).toBe('random');
  });

  it('random order is a permutation, stable within a day, different across days', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `p:m${i}`);
    const day1 = Date.UTC(2026, 9, 7, 3);
    const a = dailyShuffle(refs, day1);
    expect([...a].sort()).toEqual([...refs].sort());
    expect(dailyShuffle(refs, day1 + 3_600_000)).toEqual(a);
    expect(dailyShuffle(refs, day1 + 86_400_000)).not.toEqual(a);
    const layer = rankingLayer(refs, 'random', day1) as {
      models: { chat: string; worker: string[] };
    };
    expect(layer.models.worker).toEqual(a);
    expect(layer.models.chat).toBe(a[0]);
    expect((rankingLayer(refs) as { models: { worker: string[] } }).models.worker).toEqual(refs);
  });
});

describe('keys pasted in a sentence', () => {
  it('finds a prefixed key anywhere', () => {
    expect(findKeyInText('here is my groq key: gsk_abcdefghijklmnop1234567890 thanks')).toEqual({
      key: 'gsk_abcdefghijklmnop1234567890',
      provider: 'groq',
    });
  });
  it('pairs an unprefixed key with the provider the sentence names', () => {
    expect(findKeyInText('use this Mistral key Xy7Q2abcdEFGH1234ijklMNOP5678')?.provider).toBe(
      'mistral',
    );
    expect(findKeyInText('together api key = 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c')?.provider).toBe(
      'together',
    );
  });
  it('asks when a key-looking token names no provider, and ignores ordinary text', () => {
    expect(findKeyInText('my api key is Xy7Q2abcdEFGH1234ijklMNOP5678')).toEqual({
      key: 'Xy7Q2abcdEFGH1234ijklMNOP5678',
      provider: undefined,
    });
    expect(
      findKeyInText('fix the bug in src/core/runningContextArchive2024.ts please'),
    ).toBeUndefined();
    expect(
      findKeyInText('commit 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c broke the build'),
    ).toBeUndefined();
  });
});

describe('smart pool mode', () => {
  it('turns on Nimble routing (route only) when no judge is set up', async () => {
    const { loadConfig } = await import('../../../src/config/load.js');
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    await writeRanking(paths, ['anthropic:sonnet', 'anthropic:haiku']);
    await writePoolMode(paths, 'smart');
    const { config } = await loadConfig({ cwd: await tempDir(), env });
    expect(config.judge.kind).toBe('nimble');
    expect(config.judge.uses).toEqual(['route']);
    await writePoolMode(paths, 'ordered');
    expect((await loadConfig({ cwd: await tempDir(), env })).config.judge.kind).toBe('none');
  });
});
