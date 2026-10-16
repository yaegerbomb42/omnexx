import { describe, expect, it } from 'vitest';
import { runAgentLoop, type LoopDeps } from '../../../src/agent/loop.js';
import { budgetSchema } from '../../../src/config/schema.js';
import { RATE_LIMITED_FOR_MS, type Strategy } from '../../../src/config/routing.js';
import { ProviderError } from '../../../src/errors.js';
import { EXHAUSTED_FOR_MS, QuotaLedger } from '../../../src/providers/quota-ledger.js';
import { ScriptedProvider } from '../../support/scripted-provider.js';
import { FakeClock } from '../../support/clock.js';
import { toolContext } from '../../support/tool-context.js';
import { makeRepo } from '../../support/harness.js';
import { tempDir } from '../../support/tmp.js';

type Outcome = 'ok' | 'quota' | 'rate-limit' | 'down';

const ERRORS: Record<Exclude<Outcome, 'ok'>, () => ProviderError> = {
  quota: () => new ProviderError('quota exceeded for today', { retryable: false, status: 429 }),
  'rate-limit': () => new ProviderError('slow down', { retryable: true, status: 429 }),
  down: () => new ProviderError('bad gateway', { retryable: true, status: 502 }),
};

const price = { id: 'm', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };
const model = (provider: string) => ({ provider, alias: 'm', id: 'm', price });
const MODELS = [model('a'), model('b'), model('c')];

/** A fixture: a ranked list a, b, c behind one scripted provider, sharing one quota ledger. */
async function fixture(strategy: Strategy, extra: Partial<LoopDeps> = {}) {
  const clock = new FakeClock();
  const ledger = new QuotaLedger(`${await tempDir()}/quota.json`, () => clock.now());
  const outcome: Record<string, Outcome> = { a: 'ok', b: 'ok', c: 'ok' };
  const provider = new ScriptedProvider(({ request }) => {
    const o = outcome[request.route ?? ''] ?? 'ok';
    return o === 'ok' ? { text: 'done' } : { error: ERRORS[o]() };
  });
  const toolCtx = await toolContext(await makeRepo());
  /** One call: returns which providers were tried, in order. */
  const call = async (): Promise<string[]> => {
    const before = provider.requests.length;
    const deps: LoopDeps = {
      provider,
      models: MODELS,
      strategy,
      modelExhausted: (r) => ledger.isOut(r),
      markExhausted: (r) => {
        ledger.mark(r);
      },
      markRateLimited: (r, ms) => {
        ledger.mark(r, ms);
      },
      tools: [],
      toolCtx,
      budget: budgetSchema.parse({}),
      maxTokens: 1_000,
      clock,
      events: toolCtx.events,
      spentUsd: () => 0,
      onUsage: () => Promise.resolve(),
      control: () => Promise.resolve('continue'),
      ...extra,
    };
    await runAgentLoop(
      {
        system: [{ text: 's' }],
        first: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        tools: [],
      },
      deps,
    );
    return provider.requests.slice(before).map((r) => r.route ?? '');
  };
  return { clock, ledger, outcome, call };
}

describe('rank priority', () => {
  it('tries #1 first on every call and fails over for that call only', async () => {
    const f = await fixture('priority');
    expect(await f.call()).toEqual(['a']);
    f.outcome.a = 'down';
    expect(await f.call()).toEqual(['a', 'b']);
    f.outcome.a = 'ok';
    expect(await f.call()).toEqual(['a']);
  });

  it('still tries #1 first when the ledger says it is out of quota', async () => {
    const f = await fixture('priority');
    f.ledger.mark('a:m');
    expect(await f.call()).toEqual(['a']);
  });
});

describe('fallback on quota', () => {
  it('sticks with #2 once #1 runs out, until the reset window passes', async () => {
    const f = await fixture('fallback');
    f.outcome.a = 'quota';
    expect(await f.call()).toEqual(['a', 'b']);
    f.outcome.a = 'ok';
    expect(await f.call()).toEqual(['b']);
    f.clock.advance(EXHAUSTED_FOR_MS - 1);
    expect(await f.call()).toEqual(['b']);
    f.clock.advance(1);
    expect(await f.call()).toEqual(['a']);
  });

  it('moves off a rate-limited #1 for a short window, then goes back', async () => {
    const f = await fixture('fallback');
    f.outcome.a = 'rate-limit';
    expect(await f.call()).toEqual(['a', 'b']);
    f.outcome.a = 'ok';
    expect(await f.call()).toEqual(['b']);
    f.clock.advance(RATE_LIMITED_FOR_MS);
    expect(await f.call()).toEqual(['a']);
  });

  it('still calls a model, without waiting, when every model in the list is benched', async () => {
    const f = await fixture('fallback');
    for (const p of ['a', 'b', 'c']) f.ledger.mark(`${p}:m`, RATE_LIMITED_FOR_MS);
    const before = f.clock.now();
    expect(await f.call()).toEqual(['a']);
    expect(f.clock.now() - before).toBeLessThan(1_000);
  });

  it('still calls, without waiting, when every provider is cooling down after a failure', async () => {
    const f = await fixture('fallback', {
      providerBlocked: () => 'cooling down after a failure until later',
    });
    const before = f.clock.now();
    expect(await f.call()).toEqual(['a']);
    expect(f.clock.now() - before).toBeLessThan(1_000);
  });

  it('never calls a provider that is over its spending cap', async () => {
    const f = await fixture('fallback', {
      providerBlocked: (p) => (p === 'a' ? 'spending cap max_usd reached' : undefined),
    });
    expect(await f.call()).toEqual(['b']);
  });

  it('walks further down the list when #2 runs out too', async () => {
    const f = await fixture('fallback');
    f.outcome.a = 'quota';
    f.outcome.b = 'quota';
    expect(await f.call()).toEqual(['a', 'b', 'c']);
    expect(await f.call()).toEqual(['c']);
  });
});

describe('random', () => {
  it('spreads calls over the list and skips models out of quota', async () => {
    const f = await fixture('random');
    const first = new Set<string>();
    for (let i = 0; i < 40; i++) first.add((await f.call())[0] ?? '');
    expect(first).toEqual(new Set(['a', 'b', 'c']));
    f.ledger.mark('b:m');
    for (let i = 0; i < 20; i++) expect(await f.call()).not.toContain('b');
  });
});
