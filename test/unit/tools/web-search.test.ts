import { describe, it, expect, beforeEach } from 'vitest';
import { mockServer, json } from '../../support/mock-http.js';
import { toolContext } from '../../support/tool-context.js';
import {
  webSearchTool,
  setWebSearchConfig,
  clearWebSearchCache,
} from '../../../src/tools/extra/web_search.js';
import {
  braveResponseFixture,
  tavilyResponseFixture,
  exaResponseFixture,
  searxngResponseFixture,
} from '../../fixtures/web/recorded-fixtures.js';

describe('web_search tool', () => {
  beforeEach(() => {
    clearWebSearchCache();
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.SEARXNG_URL;
  });

  it('fails cleanly when unconfigured', async () => {
    setWebSearchConfig(undefined);
    const ctx = await toolContext(process.cwd());
    const result = await webSearchTool.run({ query: 'omnexx' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No web search backend configured');
  });

  it('searches via Brave backend', async () => {
    const { url } = await mockServer((_req, res) => {
      json(res, 200, braveResponseFixture);
    });

    process.env.BRAVE_API_KEY = 'test-brave-key';
    setWebSearchConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search: 'brave',
      search_timeout: '15s',
    });

    const originalFetch = globalThis.fetch;
    const mockedFetch: typeof fetch = (input, init) => {
      const inputStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (inputStr.startsWith('https://api.search.brave.com/')) {
        const target = inputStr.replace('https://api.search.brave.com', url);
        return originalFetch(target, init);
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = mockedFetch;

    try {
      const ctx = await toolContext(process.cwd());
      const result = await webSearchTool.run({ query: 'vitest' }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Vitest Next Generation Testing');
      expect(result.content).toContain('https://vitest.dev');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('searches via Tavily backend', async () => {
    const { url } = await mockServer((_req, res) => {
      json(res, 200, tavilyResponseFixture);
    });

    process.env.TAVILY_API_KEY = 'test-tavily-key';
    setWebSearchConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search: 'tavily',
      search_timeout: '15s',
    });

    const originalFetch = globalThis.fetch;
    const mockedFetch: typeof fetch = (input, init) => {
      const inputStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (inputStr.startsWith('https://api.tavily.com/')) {
        const target = inputStr.replace('https://api.tavily.com', url);
        return originalFetch(target, init);
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = mockedFetch;

    try {
      const ctx = await toolContext(process.cwd());
      const result = await webSearchTool.run({ query: 'agents' }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Tavily Search API');
      expect(result.content).toContain('https://tavily.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('searches via Exa backend', async () => {
    const { url } = await mockServer((_req, res) => {
      json(res, 200, exaResponseFixture);
    });

    process.env.EXA_API_KEY = 'test-exa-key';
    setWebSearchConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search: 'exa',
      search_timeout: '15s',
    });

    const originalFetch = globalThis.fetch;
    const mockedFetch: typeof fetch = (input, init) => {
      const inputStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (inputStr.startsWith('https://api.exa.ai/')) {
        const target = inputStr.replace('https://api.exa.ai', url);
        return originalFetch(target, init);
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = mockedFetch;

    try {
      const ctx = await toolContext(process.cwd());
      const result = await webSearchTool.run({ query: 'ai' }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Exa AI Search');
      expect(result.content).toContain('https://exa.ai');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('searches via SearXNG backend', async () => {
    const { url } = await mockServer((_req, res) => {
      json(res, 200, searxngResponseFixture);
    });

    setWebSearchConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search: 'searxng',
      search_url: url,
      search_timeout: '15s',
    });

    const ctx = await toolContext(process.cwd());
    const result = await webSearchTool.run({ query: 'open source' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('SearXNG Metasearch Engine');
    expect(result.content).toContain('https://searx.space');
  });

  it('retries a 429, clips long snippets, and caches the query for the run', async () => {
    clearWebSearchCache();
    let hits = 0;
    const { url } = await mockServer((_req, res) => {
      hits++;
      if (hits === 1) {
        json(res, 429, {});
        return;
      }
      json(res, 200, {
        results: [{ title: 'Long', url: 'https://example.test/long', content: 'x '.repeat(1000) }],
      });
    });
    setWebSearchConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search: 'searxng',
      search_url: url,
      search_timeout: '5s',
    });
    const ctx = await toolContext(process.cwd());
    const first = await webSearchTool.run({ query: 'cache me' }, ctx);
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('[Long](https://example.test/long)');
    expect(first.content.length).toBeLessThan(400);
    const again = await webSearchTool.run({ query: 'cache me' }, ctx);
    expect(again.content).toBe(first.content);
    expect(hits).toBe(2);
  });
});
