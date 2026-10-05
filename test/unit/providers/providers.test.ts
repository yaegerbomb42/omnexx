import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { ConfigError, ProviderError } from '../../../src/errors.js';
import { AnthropicProvider, toProviderError } from '../../../src/providers/anthropic.js';
import {
  BUILTIN_PRICING,
  costUsd,
  resolveModel,
  worstCaseUsd,
} from '../../../src/providers/pricing.js';
import { StopRequested, withRetry } from '../../../src/providers/retry.js';
import type { CompletionRequest } from '../../../src/providers/types.js';
import { FakeClock } from '../../support/clock.js';
import { json, mockServer } from '../../support/mock-http.js';

describe('pricing', () => {
  it('resolves aliases, raw ids and config overrides; refuses unknowns', () => {
    const cfg = defaultConfig({
      pricing: {
        cheapo: {
          id: 'my-model',
          input: 1,
          output: 2,
          cache_write_5m: 1,
          cache_write_1h: 2,
          cache_read: 0.1,
        },
      },
    });
    expect(resolveModel('anthropic:sonnet', cfg).id).toBe('claude-sonnet-5-5');
    expect(resolveModel('anthropic:claude-opus-5-5', cfg).alias).toBe('opus');
    expect(resolveModel('anthropic:cheapo', cfg).id).toBe('my-model');
    expect(() => resolveModel('anthropic:gpt-9', cfg)).toThrow(ConfigError);
    expect(() => resolveModel('openai:gpt', cfg)).toThrow(/unknown provider "openai"/);
  });
  it('costs each token class at its own rate (Opus 5.5 cache read is 0.05x)', () => {
    const p = BUILTIN_PRICING.opus;
    if (!p) throw new Error('missing');
    expect(
      costUsd({ uncached: 1e6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }, p),
    ).toBe(4);
    expect(
      costUsd(
        { uncached: 0, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 },
        p,
      ),
    ).toBeCloseTo(5 + 8 + 0.2 + 20);
    expect(worstCaseUsd(1e6, 1e6, p)).toBe(8 + 20);
  });
});

describe('withRetry', () => {
  const retryable = () => new ProviderError('529 overloaded', { retryable: true, status: 529 });

  it('backs off exponentially, capped at 30 min, reports outage once and recovery', async () => {
    const clock = new FakeClock();
    const events: string[] = [];
    let calls = 0;
    const out = await withRetry(
      () => (++calls < 14 ? Promise.reject(retryable()) : Promise.resolve('ok')),
      {
        clock,
        onRetry: (i) => events.push(`retry${i.attempt}`),
        onOutage: () => events.push('outage'),
        onRecovered: (_, n) => events.push(`recovered${n}`),
      },
    );
    expect(out).toBe('ok');
    expect(clock.sleeps.slice(0, 3)).toEqual([2_000, 4_000, 8_000]);
    expect(Math.max(...clock.sleeps)).toBe(30 * 60_000);
    expect(events.filter((e) => e === 'outage')).toHaveLength(1);
    expect(events.at(-1)).toBe('recovered13');
  });

  it('throws non-retryable errors immediately and honours stop requests', async () => {
    const clock = new FakeClock();
    await expect(
      withRetry(() => Promise.reject(new ProviderError('401', { retryable: false })), { clock }),
    ).rejects.toThrow('401');
    await expect(withRetry(() => Promise.reject(new Error('plain')), { clock })).rejects.toThrow(
      'plain',
    );
    await expect(
      withRetry(() => Promise.reject(retryable()), {
        clock,
        shouldStop: () => Promise.resolve(true),
      }),
    ).rejects.toBeInstanceOf(StopRequested);
  });
});

const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: 'claude-sonnet-5-5',
  system: [{ text: 'sys' }, { text: 'prefix end', cacheBreakpoint: true }],
  tools: [
    { name: 'zeta', description: 'z', inputSchema: { type: 'object' } },
    { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'state' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'opaque',
          provider: 'anthropic',
          block: { type: 'thinking', thinking: 't', signature: 's' },
        },
        { type: 'tool_use', id: 'tu1', name: 'alpha', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'out', isError: true }],
    },
  ],
  maxTokens: 100,
  messageBreakpoints: [0, 2],
  ...over,
});

describe('AnthropicProvider against a loopback mock', () => {
  it('sends sorted tools, breakpoints in the right places, round-trips opaque blocks, maps usage', async () => {
    const srv = await mockServer((_r, res) => {
      json(res, 200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tu2', name: 'alpha', input: { x: 1 } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
        },
      });
    });
    const p = new AnthropicProvider({
      apiKey: 'test-key-not-real',
      baseURL: srv.url,
      cacheTtl: '5m',
      timeoutMs: 5_000,
    });
    const res = await p.complete(req());
    expect(res.usage).toEqual({
      uncached: 10,
      cacheWrite5m: 20,
      cacheWrite1h: 10,
      cacheRead: 100,
      output: 5,
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.content.map((c) => c.type)).toEqual(['opaque', 'text', 'tool_use']);
    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as {
      tools: { name: string }[];
      system: { cache_control?: unknown }[];
      messages: { content: { type: string; cache_control?: unknown; is_error?: boolean }[] }[];
    };
    expect(body.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(body.system.map((s) => Boolean(s.cache_control))).toEqual([false, true]);
    expect(body.messages.map((m) => Boolean(m.content.at(-1)?.cache_control))).toEqual([
      true,
      false,
      true,
    ]);
    expect(body.messages[1]?.content[0]?.type).toBe('thinking');
    expect(body.messages[2]?.content[0]?.is_error).toBe(true);
  });

  it('maps errors: 429/529/5xx/network retryable; 400/401 not, with hints', async () => {
    for (const [status, retry] of [
      [429, true],
      [529, true],
      [500, true],
      [400, false],
      [401, false],
    ] as const) {
      const srv = await mockServer((_r, res) => {
        json(res, status, { type: 'error', error: { type: 'x', message: 'nope' } });
      });
      const p = new AnthropicProvider({
        apiKey: 'k',
        baseURL: srv.url,
        cacheTtl: '1h',
        timeoutMs: 5_000,
      });
      const err = (await p.complete(req()).catch((e: unknown) => e)) as ProviderError;
      expect(err, String(status)).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(retry);
      expect(err.status).toBe(status);
      if (status === 401) expect(err.hint).toMatch(/omnexx doctor/);
    }
    const dead = new AnthropicProvider({
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:9',
      cacheTtl: '5m',
      timeoutMs: 2_000,
    });
    expect(((await dead.complete(req()).catch((e: unknown) => e)) as ProviderError).retryable).toBe(
      true,
    );
    expect(toProviderError(new Error('x')).retryable).toBe(false);
    const abort = new Error('a');
    abort.name = 'AbortError';
    expect(toProviderError(abort).message).toBe('request aborted');
  });
});
