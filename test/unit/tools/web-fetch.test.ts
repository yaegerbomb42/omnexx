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
});
