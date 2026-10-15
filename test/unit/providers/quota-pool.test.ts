import { describe, expect, it } from 'vitest';
import { findKeyInText } from '../../../src/cli/connect.js';
import {
  nextPoolMode,
  parsePoolMode,
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

  it('keeps a rate-limit mark for its own window, apart from quota marks', async () => {
    let t = 1_000;
    const ledger = new QuotaLedger(`${await tempDir()}/quota.json`, () => t);
    ledger.mark('groq:fast', 60_000);
    expect(ledger.isOut('groq:fast')).toBe(true);
    expect(ledger.exhaustedAt('groq:fast')).toBeUndefined();
    expect(ledger.all()).toEqual({});
    t += 60_000;
    expect(ledger.isOut('groq:fast')).toBe(false);
    ledger.mark('groq:dry');
    ledger.mark('groq:fast', 60_000);
    ledger.clear('groq:fast');
    expect(ledger.isOut('groq:fast')).toBe(false);
    expect(ledger.isOut('groq:dry')).toBe(true);
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

  it('reads old modes as the new ones and cycles random, priority, fallback', () => {
    expect(parsePoolMode('ordered')).toBe('fallback');
    expect(parsePoolMode(undefined)).toBe('fallback');
    expect(parsePoolMode('random')).toBe('random');
    expect(parsePoolMode('smart')).toBe('smart');
    expect(nextPoolMode('random')).toBe('priority');
    expect(nextPoolMode('priority')).toBe('fallback');
    expect(nextPoolMode('fallback')).toBe('random');
    expect(nextPoolMode('smart')).toBe('random');
  });

  it('becomes the chain for chat and every run role, routed by the mode, in rank order', () => {
    const refs = ['p:a', 'p:b', 'p:c'];
    expect(rankingLayer([])).toBeUndefined();
    const layer = rankingLayer(refs, 'random') as {
      models: { chat: string[]; worker: string[]; routing: Record<string, string> };
    };
    expect(layer.models.worker).toEqual(refs);
    expect(layer.models.chat).toEqual(refs);
    expect(layer.models.routing).toEqual({
      chat: 'random',
      planner: 'random',
      worker: 'random',
      cheap: 'random',
    });
    const smart = rankingLayer(refs, 'smart') as { models: { routing: Record<string, string> } };
    expect(smart.models.routing.worker).toBe('fallback');
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
    await writePoolMode(paths, 'fallback');
    expect((await loadConfig({ cwd: await tempDir(), env })).config.judge.kind).toBe('none');
  });
});
