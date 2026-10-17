import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../src/errors.js';
import { OpenAICompatProvider } from '../../../src/providers/openai-compat.js';
import { withRetry } from '../../../src/providers/retry.js';
import type { CompletionRequest } from '../../../src/providers/types.js';
import { quirkServer, type QuirkServer } from '../../fixtures/providers/quirk-server.js';
import { FakeClock } from '../../support/clock.js';

function request(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'quirk-model',
    system: [{ text: 'sys' }],
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 32,
    messageBreakpoints: [],
    ...over,
  };
}

function provider(url: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'quirks',
    baseUrl: url,
    apiKey: 'test-key',
    timeoutMs: 5_000,
  });
}

async function withServer(
  quirks: Parameters<typeof quirkServer>[0],
  run: (srv: QuirkServer, p: OpenAICompatProvider) => Promise<void>,
): Promise<void> {
  const srv = await quirkServer(quirks);
  try {
    await run(srv, provider(srv.url));
  } finally {
    await srv.close();
  }
}

describe('openai-compat quirk matrix', () => {
  it('returns a text reply with usage when no quirk is on', async () => {
    await withServer({}, async (srv, p) => {
      expect(srv.url.startsWith('http://127.0.0.1:')).toBe(true);
      const plain = await p.complete(request());
      expect(plain.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(plain.usage).toEqual({
        uncached: 12,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 3,
      });
      const deltas: string[] = [];
      const streamed = await p.complete(
        request({
          onDelta: (d) => {
            if (d.text) deltas.push(d.text);
          },
        }),
      );
      expect(deltas).toEqual(['ok']);
      expect(streamed.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(streamed.usage.output).toBe(3);
    });
  });

  it('accepts content: null on a tool-call message and returns a usable call', async () => {
    await withServer({ nullToolContent: true }, async (_srv, p) => {
      const out = await p.complete(request());
      expect(out.stopReason).toBe('tool_use');
      expect(out.content).toEqual([
        { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'b' } },
      ]);
    });
  });

  it('retries with max_completion_tokens after max_tokens is rejected', async () => {
    await withServer({ rejectMaxTokens: true }, async (srv, p) => {
      const out = await p.complete(request({ maxTokens: 64 }));
      expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
      const bodies = srv.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({ max_tokens: 64 });
      expect(bodies[0]).not.toHaveProperty('max_completion_tokens');
      expect(bodies[1]).toMatchObject({ max_completion_tokens: 64 });
      expect(bodies[1]).not.toHaveProperty('max_tokens');
    });
  });

  it('surfaces a 429 with retry-after, and the retry helper waits that long', async () => {
    await withServer({ retryAfterSeconds: 45 }, async (srv, p) => {
      const clock = new FakeClock();
      let seen: ProviderError | undefined;
      const out = await withRetry(
        async () => {
          try {
            return await p.complete(request());
          } catch (err) {
            if (err instanceof ProviderError && !seen) seen = err;
            throw err;
          }
        },
        { clock },
      );
      expect(seen).toMatchObject({ retryable: true, status: 429, retryAfterMs: 45_000 });
      expect(clock.sleeps).toEqual([45_000]);
      expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(srv.requests).toHaveLength(2);
    });
  });

  it('reassembles one SSE JSON event that arrives in two TCP chunks', async () => {
    await withServer({ splitStream: true }, async (_srv, p) => {
      const deltas: string[] = [];
      const out = await p.complete(
        request({
          onDelta: (d) => {
            if (d.text) deltas.push(d.text);
          },
        }),
      );
      expect(deltas).toEqual(['reassembled']);
      expect(out.content).toEqual([{ type: 'text', text: 'reassembled' }]);
      expect(out.usage).toMatchObject({ uncached: 12, output: 3 });
    });
  });

  it('turns an empty choices array into a typed provider error', async () => {
    await withServer({ emptyChoices: true }, async (srv, p) => {
      const err = await p.complete(request()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable: false, status: 200 });
      expect((err as ProviderError).message).toMatch(/no choices/);
      expect(srv.requests).toHaveLength(1);
    });
  });

  it('names an unknown field on a 400 and does not retry it', async () => {
    await withServer({ unknownField: 'seed' }, async (srv, p) => {
      const clock = new FakeClock();
      const err = await withRetry(() => p.complete(request()), { clock }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable: false, status: 400 });
      expect((err as ProviderError).message).toContain('seed');
      expect(clock.sleeps).toEqual([]);
      expect(srv.requests).toHaveLength(1);
    });
  });

  it('keeps both tool calls when one response reuses a tool-call id', async () => {
    await withServer({ duplicateToolCallId: true }, async (_srv, p) => {
      const out = await p.complete(request());
      expect(out.content).toEqual([
        { type: 'tool_use', id: 'call_same', name: 'read', input: { path: 'a' } },
        { type: 'tool_use', id: 'call_same', name: 'write', input: { path: 'b' } },
      ]);
    });
  });
});
