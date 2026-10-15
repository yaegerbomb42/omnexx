import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../../../src/providers/openai-compat.js';
import {
  anthropicThinking,
  geminiThinking,
  openaiReasoning,
  withTurnEffort,
} from '../../../src/providers/turn-effort.js';
import type { CompletionRequest, Provider } from '../../../src/providers/types.js';
import { emptyUsage } from '../../../src/providers/types.js';

const req = (extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: 'm',
  system: [],
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 16_000,
  messageBreakpoints: [0],
  ...extra,
});

describe('effort per turn', () => {
  it('stamps the level on every call unless the caller set one', async () => {
    const seen: (number | undefined)[] = [];
    const inner: Provider = {
      name: 'x',
      complete: (r) => {
        seen.push(r.turnEffort);
        return Promise.resolve({
          content: [],
          stopReason: 'end_turn',
          usage: emptyUsage(),
          model: 'm',
        });
      },
    };
    const p = withTurnEffort(inner, 7);
    await p.complete(req());
    await p.complete(req({ turnEffort: 2 }));
    expect(seen).toEqual([7, 2]);
    expect(withTurnEffort(inner, undefined)).toBe(inner);
  });

  it('maps to an Anthropic thinking budget under max_tokens', () => {
    expect(anthropicThinking(req({ turnEffort: 1 }))).toBeUndefined();
    expect(anthropicThinking(req({ turnEffort: 5 }))).toEqual({
      type: 'enabled',
      budget_tokens: 6_144,
    });
    expect(anthropicThinking(req({ turnEffort: 10 }))).toEqual({
      type: 'enabled',
      budget_tokens: 14_976,
    });
    expect(anthropicThinking(req({ turnEffort: 10, maxTokens: 1_500 }))).toBeUndefined();
    expect(
      anthropicThinking(req({ turnEffort: 8, toolChoice: { type: 'tool', name: 'x' } })),
    ).toBeUndefined();
    expect(anthropicThinking(req())).toBeUndefined();
  });

  it('maps to reasoning_effort and a Gemini thinking budget', () => {
    expect(openaiReasoning(req({ turnEffort: 9 }))).toBe('high');
    expect(openaiReasoning(req())).toBeUndefined();
    expect(geminiThinking(req({ turnEffort: 1 }))).toEqual({ thinkingBudget: 128 });
    expect(geminiThinking(req({ turnEffort: 6 }))).toEqual({ thinkingBudget: 8_192 });
  });

  it('sends reasoning_effort on OpenAI-compatible calls and drops it when the model refuses', async () => {
    const bodies: Record<string, unknown>[] = [];
    const ok = {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      bodies.push(body);
      if ('reasoning_effort' in body)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: 'Unrecognized request argument: reasoning_effort' },
            }),
            {
              status: 400,
            },
          ),
        );
      return Promise.resolve(new Response(JSON.stringify(ok), { status: 200 }));
    };
    const p = new OpenAICompatProvider({
      name: 'local',
      baseUrl: 'http://localhost:1/v1',
      apiKey: undefined,
      timeoutMs: 5_000,
      fetch,
    });
    const res = await p.complete(req({ turnEffort: 9 }));
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(bodies[0]?.reasoning_effort).toBe('high');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });
});
