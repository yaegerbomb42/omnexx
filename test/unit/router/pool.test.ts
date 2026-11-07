import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../../../src/config/load.js';
import type { ConfigInput } from '../../../src/config/schema.js';
import {
  cleanProviders,
  readPoolProviders,
  writePool,
  writePoolMode,
  writeRanking,
} from '../../../src/config/ranking.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { ProviderError } from '../../../src/errors.js';
import { callOrder, orderForStrategy } from '../../../src/config/routing.js';
import { listCandidates } from '../../../src/router/candidates.js';
import {
  applyProviderPool,
  isProviderConfigured,
  providerOf,
  resolvePoolChain,
} from '../../../src/router/pool.js';
import type { CompletionRequest } from '../../../src/providers/types.js';
import { ScriptedProvider } from '../../support/scripted-provider.js';
import { startTestRun } from '../../support/harness.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const EP = {
  providers: { endpoints: { ep: { base_url: 'http://127.0.0.1:9', free: true } } },
} as const;

const CHAINS: ConfigInput = {
  models: {
    planner: ['anthropic:opus', 'ep:m1'],
    worker: ['anthropic:sonnet', 'ep:m1', 'ep:m2'],
    cheap: ['ep:m1', 'anthropic:haiku'],
    extra: ['ep:m2'],
  },
  ...EP,
};

describe('pool.providers schema', () => {
  it('defaults to every provider and accepts an ordered list', () => {
    expect(defaultConfig({}).pool.providers).toEqual([]);
    expect(defaultConfig({ pool: { providers: ['groq', 'openrouter'] } }).pool.providers).toEqual([
      'groq',
      'openrouter',
    ]);
  });

  it('rejects bad names and more than 64 providers', () => {
    expect(() => defaultConfig({ pool: { providers: ['Groq'] } })).toThrow();
    expect(() => defaultConfig({ pool: { providers: ['has space'] } })).toThrow();
    expect(() =>
      defaultConfig({ pool: { providers: Array.from({ length: 65 }, (_, i) => `p${i}`) } }),
    ).toThrow();
  });

  it('loads from [pool] in omnexx.toml', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    await writeFile(
      join(cwd, 'omnexx.toml'),
      '[pool]\nranked = ["ep:m1"]\nproviders = ["ep", "anthropic"]\n',
    );
    const { config } = await loadConfig({ cwd, env });
    expect(config.pool.providers).toEqual(['ep', 'anthropic']);
  });
});

describe('applyProviderPool', () => {
  const config = defaultConfig({ ...CHAINS, pool: { providers: ['ep', 'anthropic'] } });

  it('keeps only listed providers, in the list order, stable inside a provider', () => {
    const out = applyProviderPool(['anthropic:sonnet', 'ep:m1', 'anthropic:opus', 'ep:m2'], config);
    expect(out.refs).toEqual(['ep:m1', 'ep:m2', 'anthropic:sonnet', 'anthropic:opus']);
    expect(out.skipped).toEqual([]);
    expect(out.fellBack).toBe(false);
  });

  it('drops providers outside the list', () => {
    const out = applyProviderPool(['anthropic:sonnet', 'ep:m1', 'other:x'], config);
    expect(out.refs).toEqual(['ep:m1', 'anthropic:sonnet']);
    expect(out.skipped).toEqual(['other:x']);
  });

  it('skips a listed provider with no endpoint instead of failing', () => {
    const ghost = defaultConfig({ ...CHAINS, pool: { providers: ['ghost', 'ep'] } });
    expect(isProviderConfigured('ghost', ghost)).toBe(false);
    expect(isProviderConfigured('ep', ghost)).toBe(true);
    const out = applyProviderPool(['ghost:m1', 'ep:m1'], ghost);
    expect(out.refs).toEqual(['ep:m1']);
    expect(out.skipped).toEqual(['ghost:m1']);
    expect(out.fellBack).toBe(false);
  });

  it('falls back to the unfiltered list when nothing survives', () => {
    const ghost = defaultConfig({ ...CHAINS, pool: { providers: ['ghost'] } });
    const refs = ['anthropic:sonnet', 'ep:m1'];
    const out = applyProviderPool(refs, ghost);
    expect(out.refs).toEqual(refs);
    expect(out.skipped).toEqual(refs);
    expect(out.fellBack).toBe(true);
  });

  it('leaves the list alone when no providers are set', () => {
    const refs = ['anthropic:sonnet', 'ep:m1'];
    expect(applyProviderPool(refs, defaultConfig(CHAINS))).toEqual({
      refs,
      skipped: [],
      fellBack: false,
    });
  });

  it('providerOf splits on the first colon', () => {
    expect(providerOf('openrouter:anthropic/claude-sonnet-5.5')).toBe('openrouter');
  });
});

describe('resolvePoolChain', () => {
  it('filters then resolves, so an unconfigured provider never throws', () => {
    const config = defaultConfig({ ...CHAINS, pool: { providers: ['ep'] } });
    expect(resolvePoolChain(['anthropic:sonnet', 'ep:m1'], config).map((m) => m.provider)).toEqual([
      'ep',
    ]);
  });
});

describe('listCandidates with a provider pool', () => {
  it('lists only models on listed providers', () => {
    const config = defaultConfig({ ...CHAINS, pool: { providers: ['ep'] } });
    expect(listCandidates(config).map((c) => c.ref)).toEqual(['ep:m1', 'ep:m2']);
  });

  it('falls back to every model when the list leaves nothing', () => {
    const config = defaultConfig({ ...CHAINS, pool: { providers: ['ghost'] } });
    // Insertion order: planner first (opus, ep:m1), then worker (sonnet, ep:m2), then cheap.
    expect(listCandidates(config).map((c) => c.ref)).toEqual([
      'anthropic:opus',
      'ep:m1',
      'anthropic:sonnet',
      'ep:m2',
      'anthropic:haiku',
    ]);
  });
});

describe('pool providers round-trip', () => {
  it('survives /models saves that do not mention providers', async () => {
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    await writePool(paths, ['anthropic:opus', 'ep:m1'], 'fallback', ['ep', 'anthropic']);
    expect(await readPoolProviders(paths)).toEqual(['ep', 'anthropic']);
    await writeRanking(paths, ['anthropic:opus']);
    expect(await readPoolProviders(paths)).toEqual(['ep', 'anthropic']);
    await writePoolMode(paths, 'priority');
    expect(await readPoolProviders(paths)).toEqual(['ep', 'anthropic']);
    const { config } = await loadConfig({ cwd: await tempDir(), env });
    expect(config.pool.providers).toEqual(['ep', 'anthropic']);
    expect(config.pool.mode).toBe('priority');
    // An explicit empty list clears it.
    await writePool(paths, ['anthropic:opus'], 'fallback', []);
    expect(await readPoolProviders(paths)).toEqual([]);
  });

  it('cleanProviders drops bad names and dedupes', () => {
    expect(cleanProviders(['ep', 'Groq', 'ep', 7, 'openrouter'])).toEqual(['ep', 'openrouter']);
  });
});

describe('rotation across providers', () => {
  it('random reshuffles per call, so every provider leads sometimes', () => {
    const price = {
      id: 'm',
      input: 0,
      output: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0,
    };
    const chain = ['a', 'b', 'c'].map((provider) => ({ provider, alias: 'm', id: 'm', price }));
    let s = 1234567;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const leads = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const first = callOrder(chain, 'random', rnd)[0];
      if (first) leads.set(first.provider, (leads.get(first.provider) ?? 0) + 1);
    }
    expect([...leads.keys()].sort()).toEqual(['a', 'b', 'c']);
    for (const n of leads.values()) expect(n).toBeGreaterThanOrEqual(5);
  });

  it('least-busy orders by running helpers, then chain order', () => {
    const chain = ['a', 'b', 'c'].map((provider) => ({ provider }));
    const busy = new Map([
      ['a', 2],
      ['b', 0],
      ['c', 1],
    ]);
    expect(orderForStrategy(chain, 'least-busy', { busy }).map((m) => m.provider)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('Run chains with a provider pool', () => {
  it('keeps only the listed providers, in list order', async () => {
    const { run } = await startTestRun({
      provider: new ScriptedProvider(() => ({ text: 'done' })),
      config: { ...CHAINS, pool: { providers: ['ep'] } },
    });
    expect(run.chains.worker.map((m) => `${m.provider}:${m.id}`)).toEqual(['ep:m1', 'ep:m2']);
    expect(run.chains.planner.map((m) => `${m.provider}:${m.id}`)).toEqual(['ep:m1']);
  });

  it('falls back to the unfiltered chain when the list leaves nothing', async () => {
    const { run } = await startTestRun({
      provider: new ScriptedProvider(() => ({ text: 'done' })),
      config: { ...CHAINS, pool: { providers: ['ghost'] } },
    });
    expect(run.chains.worker.map((m) => `${m.provider}:${m.id}`)).toEqual([
      'anthropic:claude-sonnet-5-5',
      'ep:m1',
      'ep:m2',
    ]);
  });

  it('cheapComplete marks a plain 429 rate-limited in fallback mode, then skips it', async () => {
    const requests: string[] = [];
    const provider = new ScriptedProvider(({ request }) => {
      const route = request.route ?? '';
      requests.push(route);
      if (route === 'ep' && requests.filter((r) => r === 'ep').length === 1)
        return { error: new ProviderError('slow down', { retryable: true, status: 429 }) };
      return { text: 'done' };
    });
    const { run } = await startTestRun({
      provider,
      config: {
        models: { cheap: ['ep:m1', 'anthropic:haiku'] },
        ...EP,
      },
    });
    const req: Omit<CompletionRequest, 'model' | 'route'> = {
      system: [{ text: 's' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxTokens: 10,
      messageBreakpoints: [],
    };
    const first = await run.cheapComplete(req, {
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
      role: 'cheap',
    });
    expect(first?.model.provider).toBe('anthropic');
    expect(run.quota.isLimited('ep:m1')).toBe(true);
    const second = await run.cheapComplete(req, {
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
      role: 'cheap',
    });
    expect(second?.model.provider).toBe('anthropic');
    expect(requests.filter((r) => r === 'ep')).toHaveLength(1);
  });
});
