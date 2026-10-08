import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { ProviderError } from '../../../src/errors.js';
import { OpenAICompatProvider, toChatMessages } from '../../../src/providers/openai-compat.js';
import { resolveChain, resolveModel } from '../../../src/providers/pricing.js';
import { ProviderRouter, shouldFailover } from '../../../src/providers/router.js';
import type { CompletionRequest } from '../../../src/providers/types.js';
import { json, mockServer } from '../../support/mock-http.js';

const req: CompletionRequest = {
  model: 'some/model',
  system: [{ text: 'sys one' }, { text: 'sys two' }],
  tools: [
    {
      name: 'read',
      description: 'read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'opaque', provider: 'anthropic', block: {} },
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'c1', content: 'nope', isError: true }],
    },
  ],
  maxTokens: 100,
  messageBreakpoints: [0],
  toolChoice: { type: 'tool', name: 'read' },
};

describe('toChatMessages', () => {
  it('maps system, assistant tool calls, and tool results; drops provider-specific blocks', () => {
    expect(toChatMessages(req)).toEqual([
      { role: 'system', content: 'sys one\n\nsys two' },
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'reading',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ERROR: nope' },
    ]);
  });
});

describe('OpenAICompatProvider against a loopback mock', () => {
  it('sends Chat Completions with tools and auth; maps tool calls, finish reason and cached usage', async () => {
    const srv = await mockServer((_r, res) => {
      json(res, 200, {
        model: 'some/model',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                { id: 'x', function: { name: 'read', arguments: '{"path":"b"}' } },
                { function: { name: 'read', arguments: 'not json' } },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      });
    });
    const p = new OpenAICompatProvider({
      name: 'or',
      baseUrl: `${srv.url}/v1/`,
      apiKey: 'test-key',
      timeoutMs: 5_000,
    });
    const r = await p.complete(req);
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toEqual([
      { type: 'tool_use', id: 'x', name: 'read', input: { path: 'b' } },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'read',
        input: { _unparseable_arguments: 'not json' },
      },
    ]);
    expect(r.usage).toEqual({
      uncached: 200,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 800,
      output: 50,
    });
    const sent = srv.requests[0];
    expect(sent?.url).toBe('/v1/chat/completions');
    expect(sent?.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'some/model',
      max_tokens: 100,
      tool_choice: { type: 'function', function: { name: 'read' } },
    });
    expect((body.tools as unknown[])[0]).toMatchObject({
      type: 'function',
      function: { name: 'read' },
    });
  });

  it('maps plain answers and errors; local endpoints need no key', async () => {
    const ok = await mockServer((_r, res) => {
      json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
    });
    const local = new OpenAICompatProvider({
      name: 'ollama',
      baseUrl: ok.url,
      apiKey: undefined,
      timeoutMs: 5_000,
    });
    expect(await local.complete({ ...req, tools: [] })).toMatchObject({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
    });
    expect(ok.requests[0]?.headers.authorization).toBeUndefined();
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [401, false],
      [402, false],
    ] as const) {
      const srv = await mockServer((_r, res) => {
        json(res, status, { error: { message: 'nope' } });
      });
      const e = (await new OpenAICompatProvider({
        name: 'x',
        baseUrl: srv.url,
        apiKey: 'k',
        timeoutMs: 5_000,
      })
        .complete(req)
        .catch((x: unknown) => x)) as ProviderError;
      expect(e.retryable, String(status)).toBe(retryable);
      expect(shouldFailover(e)).toBe(true);
    }
    const bad = await mockServer((_r, res) => {
      res.writeHead(502).end('<html>');
    });
    expect(
      (
        (await new OpenAICompatProvider({
          name: 'x',
          baseUrl: bad.url,
          apiKey: 'k',
          timeoutMs: 5_000,
        })
          .complete(req)
          .catch((x: unknown) => x)) as ProviderError
      ).message,
    ).toMatch(/non-JSON/);
    const dead = new OpenAICompatProvider({
      name: 'x',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'k',
      timeoutMs: 2_000,
    });
    expect(((await dead.complete(req).catch((x: unknown) => x)) as ProviderError).retryable).toBe(
      true,
    );
    expect(
      shouldFailover(new ProviderError('bad request', { retryable: false, status: 400 })),
    ).toBe(false);
  });
});

describe('model chains and the router', () => {
  it('resolves endpoint models (priced, or free on a free endpoint) and chains', () => {
    const cfg = defaultConfig({
      providers: {
        endpoints: {
          openrouter: {
            base_url: 'https://openrouter.ai/api/v1',
            api_key_env: 'OPENROUTER_API_KEY',
          },
          ollama: { base_url: 'http://localhost:11434/v1', free: true },
        },
      },
      pricing: {
        'or-sonnet': {
          id: 'anthropic/claude-sonnet-5.5',
          input: 2,
          output: 10,
          cache_write_5m: 2.5,
          cache_write_1h: 4,
          cache_read: 0.2,
        },
      },
      models: { worker: ['anthropic:sonnet', 'openrouter:or-sonnet', 'ollama:qwen3:32b'] },
    });
    const chain = resolveChain(cfg.models.worker, cfg);
    expect(chain.map((m) => `${m.provider}/${m.id}`)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'openrouter/anthropic/claude-sonnet-5.5',
      'ollama/qwen3:32b',
    ]);
    expect(chain[2]?.price.output).toBe(0);
    expect(() => resolveModel('openrouter:unpriced', cfg)).toThrow(
      /no price for model "unpriced" on openrouter/,
    );
  });

  it('routes by provider name and fails clearly for an unconfigured one', async () => {
    const seen: string[] = [];
    const router = new ProviderRouter(
      new Map([
        [
          'a',
          {
            name: 'a',
            complete: (r) => {
              seen.push(r.model);
              return Promise.resolve({
                content: [],
                stopReason: 'end_turn' as const,
                usage: { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
                model: r.model,
              });
            },
          },
        ],
      ]),
    );
    await router.complete({ ...req, route: 'a' });
    expect(seen).toEqual(['some/model']);
    expect(router.has('a')).toBe(true);
    await expect(router.complete({ ...req, route: 'zz' })).rejects.toThrow(/not available/);
  });
});

describe('model limits and refusals', () => {
  const ok = { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] };
  const make = (url: string) =>
    new OpenAICompatProvider({ name: 'pool', baseUrl: url, apiKey: 'k', timeoutMs: 5_000 });

  it('learns a model output limit from a 400 and retries at it, then asks for no more', async () => {
    const srv = await mockServer((r, res) => {
      const body = JSON.parse(r.body) as { max_tokens: number };
      if (body.max_tokens > 8192)
        json(res, 400, {
          error: {
            message:
              '<400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 8192]',
          },
        });
      else json(res, 200, ok);
    });
    const p = make(srv.url);
    const big: CompletionRequest = { ...req, maxTokens: 32_000 };
    delete big.toolChoice;
    await p.complete(big);
    await p.complete(big);
    const sent = srv.requests.map((r) => (JSON.parse(r.body) as { max_tokens: number }).max_tokens);
    expect(sent).toEqual([32_000, 8192, 8192]);
  });

  it('a content-filter refusal fails over to the next model', async () => {
    const srv = await mockServer((_r, res) => {
      json(res, 400, {
        error: {
          code: 'data_inspection_failed',
          message: 'Input text data may contain inappropriate content.',
        },
      });
    });
    const err = await make(srv.url)
      .complete(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).contentFilter).toBe(true);
    expect(shouldFailover(err)).toBe(true);
    // An ordinary 400 still doesn't.
    expect(shouldFailover(new ProviderError('bad', { retryable: false, status: 400 }))).toBe(false);
  });

  it('an error event inside a 200 stream is typed like an HTTP error', async () => {
    const srv = await mockServer((_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ error: { code: 429, message: 'quota exceeded' } })}\n\ndata: [DONE]\n\n`,
      );
    });
    const err = await make(srv.url)
      .complete({ ...req, onDelta: () => undefined })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryable: true });
    expect((err as Error).message).toMatch(/quota exceeded/);
  });
});
