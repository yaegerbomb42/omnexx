import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  findProfile,
  listProfiles,
  loadModelProfiles,
  modelProfileSchema,
} from '../../../src/config/sections/models-profiles.js';
import { defaultConfig } from '../../../src/config/load.js';
import { costUsd } from '../../../src/providers/pricing.js';
import {
  costOf,
  formatCost,
  resolveChainLenient,
  resolveModelLenient,
  worstCaseOf,
} from '../../../src/providers/profiles.js';
import { discoverModels } from '../../../src/providers/discovery.js';
import { GeminiProvider } from '../../../src/providers/gemini.js';
import { ResponsesProvider } from '../../../src/providers/responses.js';
import {
  coerceToSchema,
  fixJsonText,
  parseToolArgs,
  reaskMessage,
  validateWithSchema,
  withToolRepair,
} from '../../../src/providers/repair.js';
import type { CompletionRequest, Provider } from '../../../src/providers/types.js';
import { json, mockServer } from '../../support/mock-http.js';

describe('model profiles (W3 contract shape)', () => {
  it('parses defaults and lists in sorted order', () => {
    const raw = loadModelProfiles({
      profiles: {
        'groq:llama-4-70b': { tags: ['code', 'fast'], context: 200000, vision: true, speed: 'fast', quality: 'high' },
        'anthropic:haiku': {},
        bad: { tags: [] },
      },
    });
    expect(raw['groq:llama-4-70b']?.context).toBe(200000);
    expect(raw['anthropic:haiku']?.tools).toBe(true);
    expect(raw.bad).toBeUndefined();
    const list = listProfiles(raw);
    expect(list.map((p) => p.id)).toEqual(['anthropic:haiku', 'groq:llama-4-70b']);
    expect(list[1]).toMatchObject({
      provider: 'groq',
      supportsTools: true,
      vision: true,
      speedTier: 'fast',
      qualityTier: 'high',
      contextWindow: 200000,
    });
    expect(findProfile(raw, 'groq:llama-4-70b')?.tags).toEqual(['code', 'fast']);
    expect(findProfile(raw, 'missing:x')).toBeUndefined();
    expect(modelProfileSchema.parse({})).toMatchObject({ tools: true, vision: false });
  });
});

describe('pricing optional (lenient resolver)', () => {
  it('resolves unknown models without throwing; tokens still counted, cost undefined, display "\u2013"', () => {
    const cfg = defaultConfig();
    const m = resolveModelLenient('groq:llama-4-70b', cfg);
    expect(m.id).toBe('llama-4-70b');
    expect(m.price).toBeUndefined();
    const usage = { uncached: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 };
    expect(costOf(usage, m.price)).toEqual({ usd: undefined, unpriced: true });
    expect(formatCost(undefined)).toBe('\u2013');
    expect(worstCaseOf(1000, 500, m.price)).toBeUndefined();
    // Mixed priced + unpriced accounting: priced models still cost normally.
    const priced = resolveModelLenient('anthropic:sonnet', cfg);
    expect(priced.price).toBeDefined();
    if (priced.price) {
      expect(costOf(usage, priced.price).usd).toBeCloseTo(costUsd(usage, priced.price));
      expect(formatCost(costOf(usage, priced.price).usd)).toMatch(/^\$/);
      expect(worstCaseOf(1000, 500, priced.price)).toBeGreaterThan(0);
    }
    // Lenient: unknown providers also resolve (unpriced); only malformed refs throw.
    expect(resolveModelLenient('nope:whatever', cfg).price).toBeUndefined();
    expect(() => resolveModelLenient('malformed', cfg)).toThrow();
    expect(resolveChainLenient(['anthropic:sonnet', 'groq:llama-4-70b'], cfg)).toHaveLength(2);
  });
});

describe('discovery', () => {
  it('reads OpenAI /models with context lengths; fail soft on errors', async () => {
    const srv = await mockServer((r, res) => {
      if (r.url === '/v1/models')
        json(res, 200, { data: [{ id: 'a', context_length: 128000 }, { id: 'b' }] });
      else json(res, 404, {});
    });
    const found = await discoverModels({ baseUrl: srv.url });
    expect(found).toEqual([
      { id: 'a', contextLength: 128000, ownedBy: undefined },
      { id: 'b', contextLength: undefined, ownedBy: undefined },
    ]);
    expect(await discoverModels({ baseUrl: 'http://127.0.0.1:9' }, { timeoutMs: 200 })).toEqual([]);
  });
  it('reads Ollama /api/tags', async () => {
    const srv = await mockServer((r, res) => {
      if (r.url === '/api/tags') json(res, 200, { models: [{ name: 'llama3' }] });
      else json(res, 404, {});
    });
    expect(await discoverModels({ baseUrl: srv.url, kind: 'ollama' })).toEqual([
      { id: 'llama3', contextLength: undefined, ownedBy: undefined },
    ]);
  });
});

describe('tool-call repair', () => {
  it('fixes trailing commas, single quotes, fences and stringified JSON; coerces to schema', () => {
    expect(fixJsonText('```json\n{"a": 1,}\n```')).toBe('{"a": 1}');
    expect(parseToolArgs("{'a': 1,}").value).toEqual({ a: 1 });
    expect(parseToolArgs('"{\\"a\\": 2}"').value).toEqual({ a: 2 });
    const schema = z.strictObject({ count: z.number(), name: z.string(), flag: z.boolean().optional() });
    const v = validateWithSchema({ count: '42', name: 'x', flag: 'yes' }, schema);
    expect(v).toEqual({ ok: true, value: { count: 42, name: 'x', flag: true } });
    const bad = validateWithSchema({ count: 'NaN!', name: 7 }, schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(reaskMessage('tool', bad.error, 'c1')).toMatch(/invalid/);
    expect(coerceToSchema('x', z.number())).toBe('x');
  });
  it('wrapper repairs _unparseable_arguments in place', async () => {
    const inner: Provider = {
      name: 'fake',
      complete: () => {
        return Promise.resolve({
          model: 'm',
          stopReason: 'tool_use',
          usage: { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
          content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { _unparseable_arguments: "{'p': 1,}" } }],
        });
      },
    };
    const req: CompletionRequest = { model: 'm', system: [], tools: [], messages: [], maxTokens: 1, messageBreakpoints: [] };
    const res = await withToolRepair(inner).complete(req);
    expect(res.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'read', input: { p: 1 } }]);
  });
});

describe('Gemini + Responses providers (recorded fixtures)', () => {
  it('gemini maps functionCall + usageMetadata', async () => {
    const srv = await mockServer((r, res) => {
      expect(r.url).toMatch(/:generateContent$/);
      json(res, 200, {
        candidates: [{ content: { parts: [{ text: 'hi' }, { functionCall: { name: 'read', args: { p: 'a' } } }] }, finishReason: 'TOOL_CALL' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    });
    const p = new GeminiProvider({ apiKey: 'k', baseUrl: srv.url, timeoutMs: 5_000 });
    const res = await p.complete({ model: 'gemini-2.0-flash', system: [], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 10, messageBreakpoints: [] });
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'call_0', name: 'read', input: { p: 'a' } }]);
    expect(res.usage).toMatchObject({ uncached: 10, output: 5 });
  });
  it('responses maps function_call output + usage', async () => {
    const srv = await mockServer((r, res) => {
      expect(r.url).toBe('/responses');
      json(res, 200, {
        model: 'gpt-5',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'c9', name: 'ping', arguments: '{}' }],
        usage: { input_tokens: 7, output_tokens: 3 },
      });
    });
    const p = new ResponsesProvider({ name: 'openai', baseUrl: srv.url, apiKey: 'k', timeoutMs: 5_000 });
    const res = await p.complete({ model: 'gpt-5', system: [], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 10, messageBreakpoints: [] });
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'tool_use', id: 'c9', name: 'ping', input: {} }]);
    expect(res.usage).toMatchObject({ uncached: 7, output: 3 });
  });
  it('both map HTTP errors to retryable ProviderErrors', async () => {
    const srv = await mockServer((_r, res) => json(res, 429, { error: { message: 'slow down' } }));
    const req: CompletionRequest = { model: 'm', system: [], tools: [], messages: [], maxTokens: 1, messageBreakpoints: [] };
    await expect(new GeminiProvider({ apiKey: 'k', baseUrl: srv.url, timeoutMs: 5_000 }).complete(req)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(new ResponsesProvider({ name: 'r', baseUrl: srv.url, apiKey: 'k', timeoutMs: 5_000 }).complete(req)).rejects.toMatchObject({ retryable: true, status: 429 });
  });
});
