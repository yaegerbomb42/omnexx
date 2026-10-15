import { describe, expect, it } from 'vitest';
import { authHeaders } from '../../../src/providers/auth-headers.js';
import { explainStatus, probeEndpoint } from '../../../src/providers/probe.js';

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;

/** A fake fetch: the first route that answers wins; anything else is a 404. Records calls. */
function fake(...routes: Route[]) {
  const calls: { url: string; headers: Headers; method: string }[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? 'GET' });
    for (const r of routes) {
      const res = r(url, init);
      if (res) return Promise.resolve(res);
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  return { fetch: fetchFn, calls };
}

const openaiList = Response.json({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] });

describe('probeEndpoint: flavor detection', () => {
  it('detects an OpenAI-compatible endpoint by its model list', async () => {
    const f = fake((u) => (u === 'https://h.example/v1/models' ? openaiList.clone() : undefined));
    const r = await probeEndpoint({
      baseUrl: 'https://h.example/v1/',
      apiKey: 'k',
      fetch: f.fetch,
    });
    expect(r).toMatchObject({ ok: true, flavor: 'openai-chat', baseUrl: 'https://h.example/v1' });
    expect(r.models).toEqual(['m1', 'm2']);
    expect(f.calls[0]?.headers.get('authorization')).toBe('Bearer k');
  });

  it('adds a missing /v1 and says so', async () => {
    const f = fake((u) => (u === 'https://h.example/v1/models' ? openaiList.clone() : undefined));
    const r = await probeEndpoint({ baseUrl: 'https://h.example', fetch: f.fetch });
    expect(r).toMatchObject({ ok: true, baseUrl: 'https://h.example/v1' });
    expect(r.detail).toMatch(/added \/v1/);
  });

  it('detects an Anthropic-compatible endpoint and saves the root without /v1', async () => {
    const f = fake((u, init) =>
      u === 'https://gw.example/anthropic/v1/models' &&
      new Headers(init?.headers).get('x-api-key') === 'k'
        ? Response.json({ data: [{ id: 'claude-x', type: 'model' }], has_more: false })
        : undefined,
    );
    const r = await probeEndpoint({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: 'k',
      fetch: f.fetch,
    });
    expect(r).toMatchObject({
      ok: true,
      flavor: 'anthropic',
      baseUrl: 'https://gw.example/anthropic',
    });
    expect(r.models).toEqual(['claude-x']);
    // Anthropic-looking URLs are tried in Anthropic shape first.
    expect(f.calls[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
  });

  it('finds an endpoint with no model list by the shape of its error', async () => {
    const f = fake((u, init) =>
      u === 'https://h.example/v1/chat/completions' && init?.method === 'POST'
        ? Response.json({ error: { message: 'model not found' } }, { status: 400 })
        : undefined,
    );
    const r = await probeEndpoint({ baseUrl: 'https://h.example/v1', apiKey: 'k', fetch: f.fetch });
    expect(r).toMatchObject({ ok: true, flavor: 'openai-chat', models: [] });
    expect(r.detail).toMatch(/type a model name/);
  });

  it('finds an Anthropic Messages endpoint with no model list', async () => {
    const f = fake((u) =>
      u === 'https://m.example/v1/messages'
        ? Response.json(
            { type: 'error', error: { type: 'not_found_error', message: 'model' } },
            { status: 400 },
          )
        : undefined,
    );
    const r = await probeEndpoint({ baseUrl: 'https://m.example', apiKey: 'k', fetch: f.fetch });
    expect(r).toMatchObject({ ok: true, flavor: 'anthropic', baseUrl: 'https://m.example' });
  });

  it('uses the Gemini list for Google AI Studio', async () => {
    const f = fake((u, init) =>
      u.endsWith('/v1beta/models') && new Headers(init?.headers).get('x-goog-api-key') === 'g'
        ? Response.json({ models: [{ name: 'models/gemini-3-pro' }] })
        : undefined,
    );
    const r = await probeEndpoint({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'g',
      fetch: f.fetch,
    });
    expect(r).toMatchObject({ ok: true, flavor: 'gemini', models: ['gemini-3-pro'] });
  });

  it('sends Azure-style api-key headers and extra headers', async () => {
    const f = fake((_u, init) => {
      const h = new Headers(init?.headers);
      return h.get('api-key') === 'az' && h.get('x-org') === 't' && !h.has('authorization')
        ? openaiList.clone()
        : undefined;
    });
    const r = await probeEndpoint({
      baseUrl: 'https://r.openai.azure.com/openai/v1',
      apiKey: 'az',
      auth: 'api-key',
      headers: { 'x-org': 't' },
      fetch: f.fetch,
    });
    expect(r.ok).toBe(true);
  });
});

describe('probeEndpoint: errors a person can act on', () => {
  it('says the key was rejected on a 401', async () => {
    const f = fake(() => new Response('{"error":"bad key"}', { status: 401 }));
    const r = await probeEndpoint({
      baseUrl: 'https://h.example/v1',
      apiKey: 'bad',
      fetch: f.fetch,
    });
    expect(r).toMatchObject({ ok: false, flavor: undefined });
    expect(r.detail).toMatch(/^401: key rejected/);
  });

  it('says the base URL probably needs /v1 when nothing is there', async () => {
    const f = fake();
    const r = await probeEndpoint({
      baseUrl: 'https://h.example/api',
      apiKey: 'k',
      fetch: f.fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^404: nothing at .* probably needs \/v1/);
  });

  it('says it could not reach the host when the network fails', async () => {
    const fetchFn = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const r = await probeEndpoint({ baseUrl: 'http://localhost:9/v1', fetch: fetchFn });
    expect(r.detail).toBe("couldn't reach localhost:9 — is the URL right and the server running?");
  });

  it('refuses a URL that is not http(s) without fetching', async () => {
    const f = fake();
    const r = await probeEndpoint({ baseUrl: 'ftp://x', fetch: f.fetch });
    expect(r.detail).toMatch(/http:\/\/ or https:\/\//);
    expect(f.calls).toEqual([]);
  });

  it('explains other statuses', () => {
    expect(explainStatus(403, 'u')).toMatch(/^403/);
    expect(explainStatus(429, 'u')).toMatch(/key is accepted/);
    expect(explainStatus(503, 'u')).toMatch(/server had an error/);
    expect(explainStatus(418, 'u')).toMatch(/unexpected answer from u/);
  });
});

describe('authHeaders', () => {
  it('sends bearer by default, api-key for Azure, nothing for none', () => {
    expect(authHeaders('k', undefined, undefined)).toEqual({ authorization: 'Bearer k' });
    expect(authHeaders('k', 'api-key', { a: '1' })).toEqual({ a: '1', 'api-key': 'k' });
    expect(authHeaders('k', 'none', undefined)).toEqual({});
    expect(authHeaders(undefined, 'bearer', undefined)).toEqual({});
  });
});
