import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { ProviderError } from '../../src/errors.js';
import { OpenAICompatProvider } from '../../src/providers/openai-compat.js';
import { ProviderRouter } from '../../src/providers/router.js';
import type { Provider } from '../../src/providers/types.js';
import { json, mockServer } from '../support/mock-http.js';
import { startTestRun } from '../support/harness.js';
import { call, say, ScriptedProvider } from '../support/scripted-provider.js';

const plan = {
  milestones: [
    {
      id: 'M1',
      title: 'Fix',
      tasks: [{ id: 'M1.T01', title: 'Make add() add', checks: ['node --test'] }],
    },
  ],
};
const backupPrice = {
  id: 'backup-model',
  input: 1,
  output: 2,
  cache_write_5m: 1,
  cache_write_1h: 1,
  cache_read: 0.1,
};

/** A loopback "OpenAI-compatible" backup that fixes the bug in two turns. */
async function backupServer() {
  let n = 0;
  return mockServer((_r, res) => {
    n++;
    if (n === 1) {
      json(res, 200, {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  function: {
                    name: 'str_replace',
                    arguments: JSON.stringify({
                      path: 'src/math.js',
                      old_str: 'return a - b;',
                      new_str: 'return a + b;',
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2000, completion_tokens: 40 },
      });
    } else
      json(res, 200, {
        choices: [{ finish_reason: 'stop', message: { content: 'Fixed add().' } }],
        usage: {
          prompt_tokens: 2100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 1800 },
        },
      });
  });
}

const overloaded: Provider = {
  name: 'anthropic',
  complete: () =>
    Promise.reject(new ProviderError('529 overloaded', { retryable: true, status: 529 })),
};

async function run(primary: Provider, config: object) {
  const srv = await backupServer();
  const router = new ProviderRouter(
    new Map<string, Provider>([
      ['anthropic', primary],
      [
        'backup',
        new OpenAICompatProvider({
          name: 'backup',
          baseUrl: srv.url,
          apiKey: 'k',
          timeoutMs: 5_000,
        }),
      ],
    ]),
  );
  const t = await startTestRun({
    fixture: 'ts-failing-test',
    provider: router,
    plan,
    config: {
      providers: { endpoints: { backup: { base_url: srv.url } } },
      pricing: { backup: backupPrice },
      models: { worker: ['anthropic:sonnet', 'backup:backup'] },
      ...config,
    },
  });
  await runBaseline(t.run);
  return {
    t,
    verdict: await runOneCycle(t.run, 'M1.T01'),
    events: await readEvents(t.run.store.eventsPath),
  };
}

describe('provider failover inside a cycle', () => {
  it('a failing primary fails over to the backup endpoint; spend is tracked per provider', async () => {
    const { t, verdict, events } = await run(overloaded, {});
    expect(verdict).toMatchObject({ verdict: 'accept', done: true });
    expect(events.filter((e) => e.type === 'provider.failover')).toMatchObject([
      { provider: 'anthropic', status: 529 },
    ]);
    expect(events.filter((e) => e.type === 'turn').map((e) => e.model)).toEqual([
      'backup-model',
      'backup-model',
    ]);
    expect(Object.keys(t.run.state.spend.byProvider)).toEqual(['backup']);
    // The primary is cooling: the second turn didn't even try it.
    expect(t.run.providerBlocked('anthropic')).toMatch(/cooling down/);
  });

  it('a model out of quota is marked for that model only and skipped by later runs', async () => {
    const dry: Provider = {
      name: 'anthropic',
      complete: () =>
        Promise.reject(
          new ProviderError('429 You exceeded your current quota', {
            retryable: true,
            status: 429,
          }),
        ),
    };
    const { t, verdict, events } = await run(dry, {});
    expect(verdict).toMatchObject({ verdict: 'accept', done: true });
    expect(events.filter((e) => e.type === 'provider.quota_exhausted')).toHaveLength(1);
    // The provider isn't benched, only the model, and the mark is on disk for the next session.
    expect(t.run.providerBlocked('anthropic')).toBeUndefined();
    const sonnet = t.run.chains.worker[0];
    expect(t.run.modelExhausted(`anthropic:${sonnet?.id ?? ''}`)).toBe(true);
    expect(t.run.quota.all()).toHaveProperty([`anthropic:${sonnet?.id ?? ''}`]);
  });

  it('a provider over its own max_usd is skipped without an error; the next one does the work', async () => {
    const primary = new ScriptedProvider(() => say('should not be called'));
    const srv = await backupServer();
    const router = new ProviderRouter(
      new Map<string, Provider>([
        ['anthropic', primary],
        [
          'backup',
          new OpenAICompatProvider({
            name: 'backup',
            baseUrl: srv.url,
            apiKey: 'k',
            timeoutMs: 5_000,
          }),
        ],
      ]),
    );
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: router,
      plan,
      config: {
        providers: { anthropic: { max_usd: 0.01 }, endpoints: { backup: { base_url: srv.url } } },
        pricing: { backup: backupPrice },
        models: { worker: ['anthropic:sonnet', 'backup:backup'] },
      },
    });
    t.run.state.spend.byProvider = { anthropic: 0.02 };
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'accept', done: true });
    expect(primary.requests).toHaveLength(0);
    expect(
      (await readEvents(t.run.store.eventsPath)).some((e) => e.type === 'provider.failover'),
    ).toBe(false);
  });

  it('when every provider in the chain is over its cap, the cycle ends as a budget stop', async () => {
    const srv = await backupServer();
    const primary = new ScriptedProvider(() => call('read', { path: 'src/math.js' }));
    const router = new ProviderRouter(
      new Map<string, Provider>([
        ['anthropic', primary],
        [
          'backup',
          new OpenAICompatProvider({
            name: 'backup',
            baseUrl: srv.url,
            apiKey: 'k',
            timeoutMs: 5_000,
          }),
        ],
      ]),
    );
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: router,
      plan,
      config: {
        providers: {
          anthropic: { max_usd: 0.000001 },
          endpoints: { backup: { base_url: srv.url, max_usd: 0.000001 } },
        },
        pricing: { backup: backupPrice },
        models: { worker: ['anthropic:sonnet', 'backup:backup'] },
      },
    });
    t.run.state.spend.byProvider = { anthropic: 1, backup: 1 };
    await runBaseline(t.run);
    const verdict = await runOneCycle(t.run, 'M1.T01');
    const stop = (await readEvents(t.run.store.eventsPath)).find(
      (e) => e.type === 'budget.preflight_stop',
    );
    expect(stop).toMatchObject({
      stop: 'max_usd',
      detail: expect.stringMatching(/every provider in the chain is over its own cap/) as string,
    });
    expect(verdict.reasons).toEqual(['interrupted by a budget cap before any change']);
    expect(t.run.state.budgetExhausted).toBe(true);
    expect(primary.requests).toHaveLength(0);
  });
});
