import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeSession, createBrowserTool } from '../../src/tools/extra/browser.js';
import { detectBrowserBackend } from '../../src/tools/extra/browser/detector.js';
import { tempDir } from '../support/tmp.js';
import { toolContext } from '../support/tool-context.js';

const fixtureDir = join(process.cwd(), 'test/fixtures/browser-flow');

/** Local-only: drives a real browser through a multi-step flow. Skips when none is installed. */
describe('browser multi-step flow (real browser)', () => {
  it('fills a form, waits for the result, and follows a link into a new tab', async () => {
    if (!(await detectBrowserBackend()).backend) {
      console.log('Skipping browser flow test: no browser backend available');
      return;
    }

    const server = http.createServer((req, res) => {
      const name = req.url === '/' ? 'index.html' : (req.url ?? '').replace(/^\//, '');
      void readFile(join(fixtureDir, name))
        .then((body) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(404);
          res.end('Not found');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const ctx = await toolContext(await tempDir('browser-flow-'));
    const tool = createBrowserTool({
      enabled: true,
      allow: ['127.0.0.1'],
      headless: true,
      serve_timeout: '60s',
      allow_eval: false,
    });
    const run = async (input: Parameters<typeof tool.run>[0]) => {
      const r = await tool.run(input, ctx);
      expect(r.isError, `${input.action}: ${r.content}`).toBeFalsy();
      return r.content;
    };

    try {
      expect(await run({ action: 'open', url: `${base}/` })).toContain('Opened');
      await run({ action: 'fill', ref: '#name', text: 'Ada' });
      await run({ action: 'select', ref: '#size', value: 'Large' });
      await run({ action: 'check', ref: '#gift' });
      await run({ action: 'click', ref: '#submit' });
      await run({ action: 'wait_for', text: 'Order placed: Ada, Large, gift wrapped' });
      expect(await run({ action: 'get_text', ref: '#result' })).toBe(
        'Order placed: Ada, Large, gift wrapped',
      );

      await run({ action: 'click', ref: '#details' });
      const tabs = await run({ action: 'tabs' });
      const line = tabs.split('\n').find((l) => l.includes('details.html'));
      const id = line
        ?.trim()
        .replace(/^\*\s*/, '')
        .split(/\s+/)[0];
      expect(id, tabs).toBeTruthy();
      await run({ action: 'switch_tab', tab: id ?? '' });
      expect(await run({ action: 'get_url' })).toBe(`${base}/details.html`);
      await run({ action: 'wait_for', text: 'Orders ship in 2 days.' });
    } finally {
      await closeSession(ctx.store.runId);
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  }, 120_000);
});
