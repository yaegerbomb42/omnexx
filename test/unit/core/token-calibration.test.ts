import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentLoop, type LoopDeps } from '../../../src/agent/loop.js';
import { budgetSchema } from '../../../src/config/schema.js';
import {
  loadTokenRatios,
  observeTokenRatio,
  saveTokenRatio,
  tokenRatio,
} from '../../../src/core/token-calibration.js';
import {
  calibratedTokens,
  estimateTokens,
  nextTokenRatio,
  TOKEN_RATIO_MAX,
} from '../../../src/core/tokens.js';
import type { CompletionRequest } from '../../../src/providers/types.js';
import { ScriptedProvider } from '../../support/scripted-provider.js';
import { FakeClock } from '../../support/clock.js';
import { toolContext } from '../../support/tool-context.js';
import { makeRepo } from '../../support/harness.js';
import { tempDir } from '../../support/tmp.js';

const price = { id: 'm', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };

const promptEstimate = (request: CompletionRequest): number =>
  estimateTokens(JSON.stringify([request.system, request.tools, request.messages]));

describe('token ratio EMA', () => {
  it('stays at 1 until a model is seen, then converges on a consistent 2× bias', () => {
    expect(tokenRatio({}, 'never-seen')).toBe(1);
    expect(calibratedTokens('abcdef', 1)).toBe(estimateTokens('abcdef'));
    expect(calibratedTokens('abcdef')).toBe(estimateTokens('abcdef'));

    const estimates = [1, 7, 40, 250, 1_000, 9, 88];
    let ratio = tokenRatio({}, 'seen');
    for (let i = 0; i < 40; i++) {
      const estimated = estimates[i % estimates.length] ?? 1;
      const next = nextTokenRatio(ratio, estimated, estimated * 2);
      expect(next).toBeTypeOf('number');
      ratio = next ?? ratio;
    }
    expect(ratio).toBeCloseTo(2, 1);
    expect(nextTokenRatio(ratio, 0, 20)).toBeUndefined();
    expect(nextTokenRatio(ratio, 20, 0)).toBeUndefined();
    expect(nextTokenRatio(1, 10, 1_000)).toBe(TOKEN_RATIO_MAX);
    expect(observeTokenRatio({}, '', 10, 20)).toBeUndefined();
  });

  it('reloads a ratio written beside the latency store', async () => {
    const file = join(await tempDir(), 'token-calibration.json');
    await saveTokenRatio(file, 'p:known', 1.7);
    expect(await loadTokenRatios(file)).toEqual({ 'p:known': 1.7 });
    await writeFile(file, JSON.stringify({ 'p:known': 1.7, 'p:wild': 99, broken: 'no', '': 2 }));
    expect(await loadTokenRatios(file)).toEqual({ 'p:known': 1.7, 'p:wild': TOKEN_RATIO_MAX });
    expect(await loadTokenRatios(join(await tempDir(), 'missing.json'))).toEqual({});
  });
});

describe('loop applies the ratio only after a model has been seen', () => {
  it('a 2× provider converges near 2; a new model and omitted usage stay at 1', async () => {
    const file = join(await tempDir(), 'token-calibration.json');
    const clock = new FakeClock();
    const toolCtx = await toolContext(await makeRepo());
    const seen: number[] = [];
    let raw = 0;
    const provider = new ScriptedProvider(({ request }) => {
      raw = promptEstimate(request);
      const doubled = request.model !== 'omit';
      return {
        text: 'done',
        usage: doubled
          ? { uncached: raw * 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 }
          : { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
      };
    });
    const once = (id: string): Promise<void> => {
      const deps: LoopDeps = {
        provider,
        models: [{ provider: 'p', alias: id, id, price }],
        tools: [],
        toolCtx,
        budget: budgetSchema.parse({}),
        maxTokens: 1_000,
        clock,
        events: toolCtx.events,
        spentUsd: () => 0,
        onUsage: () => Promise.resolve(),
        control: () => Promise.resolve('continue'),
        calibrationFile: file,
        onRequest: ({ inputTokens }) => {
          seen.push(inputTokens);
        },
      };
      return runAgentLoop(
        {
          system: [{ text: 's' }],
          first: { role: 'user', content: [{ type: 'text', text: 'go' }] },
          tools: [],
        },
        deps,
      ).then((result) => {
        expect(result.end).toBe('done');
      });
    };

    await once('known');
    expect(seen[0]).toBe(raw);
    for (let i = 0; i < 29; i++) await once('known');
    const learned = await loadTokenRatios(file);
    expect(learned['p:known']).toBeCloseTo(2, 1);
    expect(seen.at(-1)).toBeGreaterThan(raw * 1.9);

    expect(tokenRatio(learned, 'p:fresh')).toBe(1);
    await once('fresh');
    expect(seen.at(-1)).toBe(raw);

    const beforeOmit = await loadTokenRatios(file);
    await once('omit');
    expect(seen.at(-1)).toBe(raw);
    expect(await loadTokenRatios(file)).toEqual(beforeOmit);
  });
});
