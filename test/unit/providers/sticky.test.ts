import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../src/errors.js';
import { isQuotaError, withStickyRandom } from '../../../src/providers/sticky.js';
import type { CompletionRequest, Provider } from '../../../src/providers/types.js';
import { emptyUsage } from '../../../src/providers/types.js';
import { tempDir } from '../../support/tmp.js';

const models = [
  'pool-random',
  'glm-5.3',
  'text-embedding-v4',
  'qwen-mt-plus',
  'kimi-k2.7-code',
  'qwen3-vl-plus',
];
const listFetch: typeof fetch = () =>
  Promise.resolve(new Response(JSON.stringify({ data: models.map((id) => ({ id })) })));
const req = (model: string): CompletionRequest => ({
  model,
  system: [{ text: 's' }],
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 10,
  messageBreakpoints: [],
});

function pool(outOfQuota: Set<string>) {
  const seen: string[] = [];
  const inner: Provider = {
    name: 'pool',
    complete(r) {
      seen.push(r.model);
      if (outOfQuota.has(r.model))
        return Promise.reject(
          new ProviderError(`pool error 429: token quota exhausted for ${r.model}`, {
            retryable: true,
            status: 429,
          }),
        );
      return Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: emptyUsage(),
        model: r.model,
      });
    },
  };
  return { inner, seen };
}

describe('sticky pool-random', () => {
  it('uses one real chat model every time, then the next when its quota runs out', async () => {
    const dir = await tempDir();
    const empty = new Set<string>();
    const { inner, seen } = pool(empty);
    const opts = {
      baseUrl: 'http://pool/v1',
      apiKey: undefined,
      stateFile: join(dir, 's.json'),
      fetch: listFetch,
      shuffle: <T>(x: T[]) => x,
    };
    const p = withStickyRandom(inner, opts);
    for (let i = 0; i < 3; i++) await p.complete(req('pool-random'));
    expect(seen).toEqual(['glm-5.3', 'glm-5.3', 'glm-5.3']);
    empty.add('glm-5.3');
    const res = await p.complete(req('pool-random'));
    expect(res.model).toBe('kimi-k2.7-code');
    // Embedding, translation and vision models are never picked; named models pass through.
    await p.complete(req('glm-5.2'));
    expect(seen.at(-1)).toBe('glm-5.2');
    const state = JSON.parse(await readFile(join(dir, 's.json'), 'utf8')) as {
      current: string;
      exhausted: Record<string, number>;
    };
    expect(state.current).toBe('kimi-k2.7-code');
    expect(Object.keys(state.exhausted)).toEqual(['glm-5.3']);
    // A restart keeps the pick (warm cache) and skips the exhausted model.
    const again = pool(new Set());
    await withStickyRandom(again.inner, opts).complete(req('pool-random'));
    expect(again.seen).toEqual(['kimi-k2.7-code']);
  });

  it('tells quota errors apart from passing rate limits', () => {
    expect(
      isQuotaError(new ProviderError('429: quota exhausted', { retryable: true, status: 429 })),
    ).toBe(true);
    expect(
      isQuotaError(
        new ProviderError('429: rate limit, slow down', { retryable: true, status: 429 }),
      ),
    ).toBe(false);
    expect(isQuotaError(new Error('quota'))).toBe(false);
  });
});
