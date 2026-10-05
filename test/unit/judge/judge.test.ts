import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { CircuitBreaker, FailOpenJudge } from '../../../src/judge/fail-open.js';
import { createJudge } from '../../../src/judge/factory.js';
import { LlmJudge } from '../../../src/judge/llm.js';
import { NimbleJudge, parseAnswer } from '../../../src/judge/nimble.js';
import { NoneJudge } from '../../../src/judge/none.js';
import { fitSummary, type AgentStateSummary } from '../../../src/judge/state-summary.js';
import {
  answersMatch,
  MAX_BODY_BYTES,
  validateQuestions,
  type JudgeQuestion,
  type JudgeResult,
} from '../../../src/judge/types.js';
import { driftQuestion, nextMoveQuestion, NEXT_MOVES } from '../../../src/judge/uses.js';
import { BUILTIN_PRICING } from '../../../src/providers/pricing.js';
import type { CompletionResponse } from '../../../src/providers/types.js';
import { Redactor } from '../../../src/security/redact.js';
import { FakeClock } from '../../support/clock.js';
import { json, mockServer } from '../../support/mock-http.js';
import { secretCorpus, secretValues } from '../../support/secrets.js';

const goodAnswers = {
  answers: {
    next_move: {
      choice: 'continue',
      probabilities: Object.fromEntries(NEXT_MOVES.map((m) => [m, m === 'continue' ? 0.7 : 0.05])),
      confidence: 0.6,
    },
    drift: { probability: 0.9 },
  },
};

async function ollama(
  handler: (path: string) => { status: number; body: unknown } | 'hang' | 'garbage',
) {
  return mockServer(async (req, res) => {
    const r = handler(req.url);
    if (r === 'hang') {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      res.end();
      return;
    }
    if (r === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{not json');
      return;
    }
    json(res, r.status, r.body);
  });
}

const nimble = (url: string, clock = new FakeClock(), timeoutMs = 500) =>
  new NimbleJudge({
    url,
    model: 'nimble',
    timeoutMs,
    keepAlive: '30m',
    fetch: globalThis.fetch,
    clock,
  });

describe('NimbleJudge against a mock /v1/systemone', () => {
  it('answers: sends the documented request shape and parses typed answers', async () => {
    const srv = await ollama((p) =>
      p === '/api/version'
        ? { status: 200, body: { version: '0.35.2' } }
        : { status: 200, body: goodAnswers },
    );
    const r = await nimble(srv.url).ask('next_move', { a: 1 }, [nextMoveQuestion, driftQuestion]);
    expect(r).toMatchObject({
      status: 'answered',
      model: 'nimble',
      endpointHost: new URL(srv.url).host,
    });
    const body = JSON.parse(
      srv.requests.find((q) => q.url === '/v1/systemone')?.body ?? '{}',
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'nimble', state: { a: 1 }, keep_alive: '30m' });
    expect((body.questions as { name: string; options?: string[] }[])[0]).toMatchObject({
      name: 'next_move',
      type: 'choice',
      options: [...NEXT_MOVES],
    });
    // The version check is cached after the first success.
    await nimble(srv.url).ask('drift', {}, [driftQuestion]);
  });

  it('accepts answers as an array keyed by name', async () => {
    const srv = await ollama((p) =>
      p === '/api/version'
        ? { status: 200, body: { version: '0.36.0' } }
        : { status: 200, body: { answers: [{ name: 'drift', probability: 0.2 }] } },
    );
    expect((await nimble(srv.url).ask('drift', {}, [driftQuestion])).status).toBe('answered');
  });

  it.each([
    ['5xx', () => ({ status: 503, body: {} }), /HTTP 503/],
    ['malformed JSON', () => 'garbage' as const, /malformed JSON/],
    ['missing answers', () => ({ status: 200, body: { nope: 1 } }), /no answers/],
    [
      'wrong option',
      () => ({
        status: 200,
        body: {
          answers: { next_move: { choice: 'dance', probabilities: { dance: 1 }, confidence: 1 } },
        },
      }),
      /not one of the options/,
    ],
    [
      'wrong shape',
      () => ({ status: 200, body: { answers: { next_move: { choice: 1 } } } }),
      /malformed answer/,
    ],
    [
      'probability out of range',
      () => ({
        status: 200,
        body: {
          answers: {
            next_move: { choice: 'continue', probabilities: { continue: 7 }, confidence: 0.5 },
          },
        },
      }),
      /out of range/,
    ],
  ])('abstains on %s', async (_name, systemone, reason) => {
    const srv = await ollama((p) =>
      p === '/api/version' ? { status: 200, body: { version: '0.35.0' } } : systemone(),
    );
    const r = await nimble(srv.url).ask('next_move', {}, [nextMoveQuestion]);
    expect(r.status).toBe('abstain');
    if (r.status === 'abstain') expect(r.reason).toMatch(reason);
  });

  it('abstains on old Ollama, refused connection, timeout, oversize requests and bad questions', async () => {
    const old = await ollama(() => ({ status: 200, body: { version: '0.34.0' } }));
    expect(await nimble(old.url).ask('drift', {}, [driftQuestion])).toMatchObject({
      reason: expect.stringMatching(/older than 0.35/) as string,
    });
    expect(await nimble('http://127.0.0.1:9').ask('drift', {}, [driftQuestion])).toMatchObject({
      status: 'abstain',
    });
    const hang = await ollama(() => 'hang');
    expect(
      await nimble(hang.url, new FakeClock(), 200).ask('drift', {}, [driftQuestion]),
    ).toMatchObject({ reason: expect.stringMatching(/timeout/) as string });
    expect(
      await nimble(old.url).ask('drift', { big: 'x'.repeat(MAX_BODY_BYTES) }, [driftQuestion]),
    ).toMatchObject({ reason: expect.stringMatching(/too large/) as string });
    expect(
      await nimble(old.url).ask('drift', { big: 'x'.repeat(40_000) }, [driftQuestion]),
    ).toMatchObject({ reason: expect.stringMatching(/8192/) as string });
    expect(await nimble(old.url).ask('drift', {}, [])).toMatchObject({
      reason: expect.stringMatching(/invalid questions/) as string,
    });
  });

  it('parseAnswer handles score answers and rejects junk', () => {
    const q: JudgeQuestion = { id: 's', type: 'score', prompt: 'p', levels: ['lo', 'hi'] };
    expect(
      parseAnswer(q, { score: 1, probabilities: { lo: 0, hi: 1 }, confidence: 1 }),
    ).toMatchObject({ type: 'score', score: 1 });
    expect(parseAnswer(q, { score: 'x' })).toBeUndefined();
    expect(parseAnswer(q, { score: 1, probabilities: { lo: 'x' }, confidence: 1 })).toBeUndefined();
    expect(
      answersMatch([q], [{ id: 's', type: 'score', score: 5, probabilities: {}, confidence: 1 }]),
    ).toMatch(/out of range/);
    expect(answersMatch([q], [{ id: 's', type: 'noul', probability: 1 }])).toMatch(
      /expected score/,
    );
    expect(validateQuestions([{ id: 'c', type: 'choice', prompt: 'p', options: ['one'] }])).toMatch(
      /2-26/,
    );
  });
});

describe('CircuitBreaker + FailOpenJudge', () => {
  class Scripted {
    readonly kind = 'nimble';
    calls = 0;
    constructor(public results: JudgeResult[]) {}
    ask(): Promise<JudgeResult> {
      this.calls++;
      return Promise.resolve(
        this.results.shift() ?? { status: 'abstain', reason: 'down', judge: 'nimble' },
      );
    }
  }
  const answered: JudgeResult = {
    status: 'answered',
    answers: [{ id: 'drift', type: 'noul', probability: 0.9 }],
    judge: 'nimble',
    latencyMs: 1,
    model: 'nimble',
    inputBytes: 10,
    endpointHost: 'h',
  };

  it('opens after N misses, skips calls, re-probes on schedule and recovers (simulated clock)', async () => {
    const clock = new FakeClock();
    const primary = new Scripted([]);
    const events: string[] = [];
    const judge = new FailOpenJudge(
      primary,
      undefined,
      new CircuitBreaker(3, 600_000, clock),
      { emit: (t) => events.push(t) },
      new Redactor(),
      new Set(['drift']),
    );
    for (let i = 0; i < 5; i++) await judge.ask('drift', {}, [driftQuestion]);
    expect(primary.calls).toBe(3);
    expect(judge.breakerState).toBe('open');
    expect(events.filter((e) => e === 'judge.miss')).toHaveLength(3);
    expect(events.filter((e) => e === 'judge.unavailable')).toHaveLength(1);
    clock.advance(600_000);
    expect(judge.breakerState).toBe('half-open');
    await judge.ask('drift', {}, [driftQuestion]); // failed probe re-opens
    expect(primary.calls).toBe(4);
    expect(judge.breakerState).toBe('open');
    clock.advance(600_000);
    primary.results.push(answered);
    expect((await judge.ask('drift', {}, [driftQuestion])).status).toBe('answered');
    expect(judge.breakerState).toBe('closed');
    expect(events.at(-1)).toBe('judge.decision');
  });

  it('half-open admits one probe at a time; throwing judges count as misses', async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(1, 10, clock);
    b.failure();
    clock.advance(10);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
    const thrower = { kind: 'nimble', ask: () => Promise.reject(new Error('kaboom')) };
    const events: string[] = [];
    const j = new FailOpenJudge(
      thrower,
      undefined,
      new CircuitBreaker(3, 10, clock),
      { emit: (t) => events.push(t) },
      new Redactor(),
      new Set(['drift']),
    );
    expect(await j.ask('drift', {}, [driftQuestion])).toMatchObject({
      status: 'abstain',
      reason: expect.stringMatching(/kaboom/) as string,
    });
  });

  it('uses the fallback on a miss, redacts state before it leaves, and respects disabled uses', async () => {
    const seen: unknown[] = [];
    const fb = {
      kind: 'llm',
      ask: (_u: string, state: unknown) => {
        seen.push(state);
        return Promise.resolve({ ...answered, judge: 'llm' });
      },
    };
    const events: { t: string; d: Record<string, unknown> }[] = [];
    const j = new FailOpenJudge(
      new Scripted([]),
      fb,
      new CircuitBreaker(3, 10, new FakeClock()),
      { emit: (t, d) => events.push({ t, d }) },
      new Redactor(),
      new Set(['drift']),
    );
    const r = await j.ask('drift', { key: secretCorpus().anthropic }, [driftQuestion]);
    expect(r).toMatchObject({ status: 'answered', judge: 'llm' });
    expect(JSON.stringify(seen)).not.toContain(secretCorpus().anthropic);
    expect(events.map((e) => e.t)).toEqual(['judge.miss', 'judge.decision']);
    expect(await j.ask('tool_safety', {}, [driftQuestion])).toMatchObject({
      reason: 'judge disabled',
    });
    expect(j.enabled('tool_safety')).toBe(false);
  });

  it('judge off makes zero HTTP calls', async () => {
    let calls = 0;
    const counting = ((...a: Parameters<typeof fetch>) => {
      calls++;
      return fetch(...a);
    }) as typeof fetch;
    const judge = createJudge({
      config: defaultConfig(),
      clock: new FakeClock(),
      events: { emit: () => undefined },
      redactor: new Redactor(),
      fetch: counting,
      llm: () => {
        throw new Error('not used');
      },
    });
    for (const use of ['next_move', 'drift', 'failure_similarity', 'tool_safety'] as const)
      await judge.ask(use, {}, [driftQuestion]);
    expect(calls).toBe(0);
    expect(judge.kind).toBe('none');
    expect(await new NoneJudge().ask()).toMatchObject({ status: 'abstain' });
  });

  it('factory wires nimble with an llm fallback', () => {
    let built = 0;
    const j = createJudge({
      config: defaultConfig({ judge: { kind: 'nimble', fallback: 'llm' } }),
      clock: new FakeClock(),
      events: { emit: () => undefined },
      redactor: new Redactor(),
      fetch: globalThis.fetch,
      llm: () => {
        built++;
        return {} as LlmJudge;
      },
    });
    expect(j.kind).toBe('nimble');
    expect(built).toBe(1);
  });
});

describe('LlmJudge', () => {
  const resp = (input: unknown): CompletionResponse => ({
    content: [{ type: 'tool_use', id: 't', name: 'answer', input }],
    stopReason: 'tool_use',
    usage: { uncached: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 5 },
    model: 'm',
  });
  const make = (input: unknown, allow = true) => {
    const model = {
      provider: 'anthropic',
      alias: 'haiku',
      id: 'claude-haiku-4-5-20251001',
      price: BUILTIN_PRICING.haiku ?? ({} as never),
    };
    const spent: number[] = [];
    const judge = new LlmJudge({
      clock: new FakeClock(),
      complete: () => {
        if (!allow) return Promise.resolve(undefined);
        const res = resp(input);
        spent.push(res.usage.output);
        return Promise.resolve({ res, model });
      },
    });
    return { judge, spent };
  };

  it('answers choice/noul/score via a forced tool call and counts spend', async () => {
    const { judge, spent } = make({
      answers: [
        { id: 'next_move', choice: 'park_and_move_on', confidence: 0.7 },
        { id: 'drift', probability: 0.1, confidence: 0.9 },
        { id: 's', score: 1, confidence: 0.5 },
      ],
    });
    const r = await judge.ask('next_move', {}, [
      nextMoveQuestion,
      driftQuestion,
      { id: 's', type: 'score', prompt: 'p', levels: ['a', 'b', 'c'] },
    ]);
    expect(r.status).toBe('answered');
    if (r.status !== 'answered') return;
    expect(r.answers[0]).toMatchObject({ choice: 'park_and_move_on', confidence: 0.7 });
    expect(r.answers[2]).toMatchObject({ type: 'score', score: 1 });
    expect(spent).toEqual([5]);
  });

  it('abstains when the budget refuses, or the answer is invalid', async () => {
    expect(await make({}, false).judge.ask('drift', {}, [driftQuestion])).toMatchObject({
      reason: 'budget',
    });
    expect(await make({ answers: [] }).judge.ask('drift', {}, [driftQuestion])).toMatchObject({
      status: 'abstain',
    });
    expect(
      await make({ answers: [{ id: 'next_move', choice: 'fly', confidence: 1 }] }).judge.ask(
        'next_move',
        {},
        [nextMoveQuestion],
      ),
    ).toMatchObject({ reason: expect.stringMatching(/invalid pick/) as string });
    expect(
      await make({ answers: [{ id: 'drift', confidence: 1 }] }).judge.ask('drift', {}, [
        driftQuestion,
      ]),
    ).toMatchObject({ reason: expect.stringMatching(/no probability/) as string });
    const broken = new LlmJudge({
      clock: new FakeClock(),
      complete: () => Promise.reject(new Error('down')),
    });
    expect(await broken.ask('drift', {}, [driftQuestion])).toMatchObject({
      reason: expect.stringMatching(/provider error/) as string,
    });
  });
});

describe('state summary size limits (property)', () => {
  it('always fits 16 KiB of state and a 64 KiB / 8K-token request, with no secrets', () => {
    const secrets = secretValues();
    const redactor = new Redactor();
    for (let n = 0; n < 60; n++) {
      const big = (k: number) =>
        Array.from(
          { length: k * 37 },
          (_, i) => `failure ${i} ${secrets[i % secrets.length] ?? ''} ${'z'.repeat(i % 500)}`,
        );
      const summary: AgentStateSummary = {
        goal: `goal ${'g'.repeat(n * 1_000)}`,
        task: { id: 'M1.T01', title: 't'.repeat(n * 50), acceptance: big(n), attempts: n },
        lastResult: { outcome: 'rejected', passed: 1, failed: 2, topFailures: big(n) },
        recentSignatures: big(n),
        diff: { files: n, added: n, removed: n },
        approachesTried: big(n),
        budgetLeft: { usd: 1, cycles: 2, hours: 3 },
        notes: big(n),
      };
      const fitted = redactor.value(fitSummary(summary));
      const body = JSON.stringify({
        model: 'nimble',
        state: fitted,
        questions: [nextMoveQuestion, driftQuestion],
        keep_alive: '30m',
      });
      expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024);
      expect(body.length / 3.5).toBeLessThanOrEqual(8_192);
      for (const s of secrets) expect(body).not.toContain(s);
      expect(fitted.task.id).toBe('M1.T01');
    }
  });
});
