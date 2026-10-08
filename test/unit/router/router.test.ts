import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import type { ConfigInput } from '../../../src/config/schema.js';
import { planNodeSchema } from '../../../src/core/plan.js';
import type { Judge, JudgeResult } from '../../../src/judge/types.js';
import { resolveChain } from '../../../src/providers/pricing.js';
import { listCandidates, unfit } from '../../../src/router/candidates.js';
import { cycleAction, cycleRoute } from '../../../src/router/classify.js';
import { ModelRouter } from '../../../src/router/router.js';

const BASE: ConfigInput = {
  models: {
    planner: 'anthropic:opus',
    worker: ['anthropic:sonnet', 'local:qwen-coder'],
    cheap: 'local:qwen-small',
    extra: ['local:llava'],
    profiles: {
      'local:qwen-coder': { quality: 'mid', speed: 'fast', tags: ['code'] },
      'local:llava': { vision: true, tools: false, quality: 'low' },
    },
  },
  providers: { endpoints: { local: { base_url: 'http://localhost:11434/v1', free: true } } },
};

function setup(input: ConfigInput, judge?: Judge) {
  const config = defaultConfig(input);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const router = new ModelRouter({
    config,
    ...(judge ? { judge } : {}),
    roleChains: {
      planner: resolveChain(config.models.planner, config),
      worker: resolveChain(config.models.worker, config),
      cheap: resolveChain(config.models.cheap, config),
    },
    events: {
      emit: (type: string, data: Record<string, unknown>) => events.push({ type, data }),
    } as never,
    now: () => 0,
  });
  return { config, router, events };
}

const answer = (choice: string, p: number): Judge => ({
  kind: 'fake',
  ask: (): Promise<JudgeResult> =>
    Promise.resolve({
      status: 'answered',
      answers: [
        { id: 'model', type: 'choice', choice, probabilities: { [choice]: p }, confidence: p },
      ],
      judge: 'fake',
      latencyMs: 5,
      model: 'nimble',
      inputBytes: 10,
      endpointHost: 'localhost',
    }),
});
const nimble = { judge: { kind: 'nimble' as const } };
const ids = (chain: { provider: string; id: string }[]): string[] =>
  chain.map((m) => `${m.provider}:${m.id}`);

describe('candidates', () => {
  it('lists every configured model once, with role-derived quality unless profiled', () => {
    const c = listCandidates(defaultConfig(BASE));
    expect(c.map((x) => x.ref)).toEqual([
      'anthropic:opus',
      'anthropic:sonnet',
      'local:qwen-coder',
      'local:qwen-small',
      'local:llava',
    ]);
    expect(c.find((x) => x.ref === 'anthropic:opus')).toMatchObject({
      quality: 'high',
      speed: 'slow',
    });
    expect(c.find((x) => x.ref === 'local:qwen-coder')).toMatchObject({
      quality: 'mid',
      speed: 'fast',
    });
    const llava = c.find((x) => x.ref === 'local:llava');
    expect(llava && unfit(llava, { tools: true })).toBe('no tool use');
  });
});

describe('ModelRouter', () => {
  it('uses the role chain when no judge is configured', async () => {
    const { router, events } = setup(BASE);
    const d = await router.pick({ action: 'edit-small', needs: { tools: true } });
    expect(d.by).toBe('rules');
    expect(ids(d.chain)).toEqual(['anthropic:claude-sonnet-5-5', 'local:qwen-coder']);
    expect(events[0]).toMatchObject({
      type: 'route.decision',
      data: { action: 'edit-small', by: 'rules' },
    });
  });

  it('takes a confident judge pick first and keeps the role chain as failover', async () => {
    const { router } = setup({ ...BASE, ...nimble }, answer('local:qwen-coder', 0.9));
    const d = await router.pick({ action: 'edit-small', needs: { tools: true } });
    expect(d).toMatchObject({ by: 'judge', probability: 0.9 });
    expect(ids(d.chain)).toEqual(['local:qwen-coder', 'anthropic:claude-sonnet-5-5']);
  });

  it('falls back to rules when the judge is unsure or abstains', async () => {
    const unsure = setup({ ...BASE, ...nimble }, answer('local:qwen-coder', 0.3));
    expect(await unsure.router.pick({ action: 'edit-small' })).toMatchObject({
      by: 'rules',
      reason: expect.stringContaining('unsure') as string,
    });
    const abstain = setup(
      { ...BASE, ...nimble },
      { kind: 'x', ask: () => Promise.resolve({ status: 'abstain', reason: 'down', judge: 'x' }) },
    );
    expect(await abstain.router.pick({ action: 'edit-small' })).toMatchObject({
      by: 'rules',
      reason: 'judge abstained: down',
    });
  });

  it('never offers the judge a model that lacks a needed capability', async () => {
    let offered: string[] = [];
    const spy: Judge = {
      kind: 'spy',
      ask: (_u, _s, qs) => {
        const q = qs[0];
        offered = q?.type === 'choice' ? q.options : [];
        return Promise.resolve({ status: 'abstain', reason: 'spy', judge: 'spy' });
      },
    };
    const { router } = setup({ ...BASE, ...nimble }, spy);
    await router.pick({ action: 'edit-large', needs: { tools: true, minQuality: 'mid' } });
    expect(offered).toEqual(['anthropic:opus', 'anthropic:sonnet', 'local:qwen-coder']);
  });

  it('honours pins and the rules kind', async () => {
    const pinned = setup(
      { ...BASE, ...nimble, router: { pin: { plan: 'local:qwen-coder' } } },
      answer('anthropic:opus', 1),
    );
    const d = await pinned.router.pick({ action: 'plan' });
    expect(d.by).toBe('pin');
    expect(ids(d.chain)[0]).toBe('local:qwen-coder');
    const rules = setup(
      { ...BASE, ...nimble, router: { kind: 'rules' } },
      answer('local:qwen-coder', 1),
    );
    expect((await rules.router.pick({ action: 'edit-small' })).by).toBe('rules');
    const llm = setup({ ...BASE, judge: { kind: 'llm' } }, answer('local:qwen-coder', 1));
    expect(llm.router.mode).toBe('rules');
  });

  it('routes planning to the planner chain and escalated tasks to high quality only', async () => {
    const { router } = setup(BASE);
    expect(ids((await router.pick({ action: 'plan' })).chain)).toEqual([
      'anthropic:claude-opus-5-5',
    ]);
    const task = planNodeSchema.parse({
      id: 'M1.T01',
      title: 'add login',
      type: 'task',
      parentId: 'M1',
      escalated: true,
    });
    const d = await router.pick(cycleRoute(task, 0.5));
    expect(ids(d.chain)).toEqual(['anthropic:claude-opus-5-5']);
  });
});

describe('cycleAction', () => {
  const t = (over: Record<string, unknown>) =>
    planNodeSchema.parse({
      id: 'M1.T01',
      title: 'something',
      type: 'task',
      parentId: 'M1',
      ...over,
    });
  it('maps kind, size and failures to actions', () => {
    expect(cycleAction(t({ size: 'S' }))).toBe('edit-small');
    expect(cycleAction(t({ size: 'L' }))).toBe('edit-large');
    expect(cycleAction(t({ kind: 'tests' }))).toBe('write-tests');
    expect(cycleAction(t({ kind: 'migration' }))).toBe('refactor');
    expect(cycleAction(t({ kind: 'investigate' }))).toBe('read-explore');
    expect(cycleAction(t({ consecutiveRejections: 1 }))).toBe('debug-failure');
  });
});

describe('smart pool routing', () => {
  it('guesses tiers from model names', async () => {
    const { guessFromName } = await import('../../../src/router/candidates.js');
    expect(guessFromName('p:gpt-oss-120b')).toEqual({ quality: 'high', speed: 'slow' });
    expect(guessFromName('p:qwen3.5-9b')).toEqual({ quality: 'low', speed: 'fast' });
    expect(guessFromName('p:gemini-2.5-flash')).toEqual({ quality: 'low', speed: 'fast' });
    expect(guessFromName('p:codestral-latest')).toEqual({ quality: 'mid', speed: 'normal' });
    expect(guessFromName('p:something')).toBeUndefined();
  });

  it('never offers the judge a model that is out of quota', async () => {
    const pool = ['local:big-120b', 'local:small-8b', 'local:coder-32b'];
    const config = defaultConfig({
      ...nimble,
      models: { planner: pool, worker: pool, cheap: pool },
      providers: { endpoints: { local: { base_url: 'http://localhost:11434/v1', free: true } } },
    });
    let offered: string[] = [];
    const judge: Judge = {
      kind: 'fake',
      ask: (_use, _facts, qs) => {
        const q = qs[0];
        offered = q?.type === 'choice' ? [...q.options] : [];
        return answer('local:coder-32b', 0.9).ask(_use, _facts, qs);
      },
    };
    const chain = resolveChain(pool, config);
    const router = new ModelRouter({
      config,
      judge,
      roleChains: { planner: chain, worker: chain, cheap: chain },
      now: () => 0,
      modelExhausted: (r) => r === 'local:big-120b',
    });
    const d = await router.pick({ action: 'edit-large' });
    expect(offered).toEqual(['local:small-8b', 'local:coder-32b']);
    expect(d.by).toBe('judge');
    expect(ids(d.chain)[0]).toBe('local:coder-32b');
  });
});
