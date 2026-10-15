import { describe, it, expect, beforeEach } from 'vitest';
import { mockServer } from '../../support/mock-http.js';
import { toolContext } from '../../support/tool-context.js';
import {
  webFetchTool,
  clearWebFetchCache,
  setWebConfig,
} from '../../../src/tools/extra/web_fetch.js';
import {
  sampleArticleHtml,
  robotsTxtDisallowingSecret,
} from '../../fixtures/web/recorded-fixtures.js';

describe('web_fetch tool', () => {
  beforeEach(() => {
    clearWebFetchCache();
    setWebConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search_timeout: '15s',
    });
  });

  it('fetches HTML and extracts readable article text as markdown', async () => {
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(sampleArticleHtml);
    });

    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/article` }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('# Understanding Modern Coding Agents');
    expect(result.content).toContain('Jane Doe');
    expect(result.content).toContain('Autonomous agents are changing software development.');
  });

  it('respects robots.txt disallow rules', async () => {
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(robotsTxtDisallowingSecret);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Secret Admin Panel</h1>');
    });

    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/admin` }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('disallowed by robots.txt');
  });

  it('respects deny list configuration', async () => {
    setWebConfig({
      allow: ['*'],
      deny: ['127.0.0.1'],
      fetch_timeout: '15s',
      max_fetch_bytes: 5 * 1024 * 1024,
      search_timeout: '15s',
    });

    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: 'http://127.0.0.1:9999/test' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not allowed by policy');
  });

  it('enforces 5MB response cap', async () => {
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-length': '10000000' }).end('x'.repeat(100));
    });

    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/big` }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeds maximum limit of 5 MB');
  });

  it('caches responses per run by URL', async () => {
    let callCount = 0;
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      callCount++;
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`Call #${callCount}`);
    });

    const ctx = await toolContext(process.cwd());
    const first = await webFetchTool.run({ url: `${url}/cached` }, ctx);
    expect(first.content).toBe('Call #1');

    const second = await webFetchTool.run({ url: `${url}/cached` }, ctx);
    expect(second.content).toBe('Call #1');
    expect(callCount).toBe(1);
  });

  it('splits a long page into pages and serves later pages from the cache', async () => {
    let hits = 0;
    const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`);
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      hits++;
      res.writeHead(200, { 'content-type': 'text/plain' }).end(paras.join('\n\n'));
    });
    const ctx = await toolContext(process.cwd());

    const first = await webFetchTool.run({ url: `${url}/long`, maxTokens: 500 }, ctx);
    const m = /\[page 1 of (\d+); call web_fetch again with page: 2 for more\]$/.exec(
      first.content,
    );
    expect(m).not.toBeNull();
    const total = Number(m?.[1]);
    expect(first.content).toContain('Paragraph 0');
    // Pages end on paragraph boundaries.
    expect(first.content.split('\n\n[page')[0]).toMatch(/word$/);

    const last = await webFetchTool.run({ url: `${url}/long`, maxTokens: 500, page: total }, ctx);
    expect(last.content).toContain('Paragraph 39');
    expect(last.content).toContain(`[page ${total} of ${total}; end of document]`);
    expect(hits).toBe(1);

    const past = await webFetchTool.run(
      { url: `${url}/long`, maxTokens: 500, page: total + 1 },
      ctx,
    );
    expect(past.isError).toBe(true);
    expect(past.content).toContain(`has ${total} page(s)`);
  });

  it('retries a transient 503 and returns the page', async () => {
    let hits = 0;
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      hits++;
      if (hits === 1) return void res.writeHead(503, { 'retry-after': '0' }).end('busy');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('fine now');
    });
    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/flaky` }, ctx);
    expect(result.content).toBe('fine now');
    expect(hits).toBe(2);
  });

  it('times out a server that never answers, with a clear error', async () => {
    setWebConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '200ms',
      max_fetch_bytes: 1024 * 1024,
      search_timeout: '1s',
    });
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      // Never responds.
    });
    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/hang` }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out after 200ms \(after 3 attempts\)/);
  }, 15_000);

  it('stops downloading at the size cap when there is no content-length', async () => {
    setWebConfig({
      allow: ['*'],
      deny: [],
      fetch_timeout: '5s',
      max_fetch_bytes: 1024 * 1024,
      search_timeout: '1s',
    });
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 3; i++) res.write('y'.repeat(1024 * 1024));
      res.end();
    });
    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/huge`, maxTokens: 100_000_000 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('[download stopped at the 1 MB cap]');
    expect(result.content.length).toBeLessThan(1024 * 1024 + 100);
  });

  it('returns far fewer tokens than the raw HTML of a noisy page', async () => {
    const noise = `<nav>${'<a href="/x">Link</a> '.repeat(200)}</nav><script>${'var a=1;'.repeat(2000)}</script>`;
    const html = `<!doctype html><html><head><title>Doc</title><style>${'p{}'.repeat(2000)}</style></head><body>${noise}<main><article><h1>Doc</h1><p>The answer is 42, as documented here in a reasonably long sentence.</p></article></main><footer>${'legal '.repeat(500)}</footer></body></html>`;
    const { url } = await mockServer((req, res) => {
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });
    const ctx = await toolContext(process.cwd());
    const result = await webFetchTool.run({ url: `${url}/doc` }, ctx);
    expect(result.content).toContain('The answer is 42');
    expect(result.content.length / html.length).toBeLessThan(0.02);
  });
});
