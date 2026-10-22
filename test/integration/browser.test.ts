import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runBrowserGate } from '../../src/verify/browser-gate.js';
import {
  detectBrowserBackend,
  createBrowserBackend,
} from '../../src/tools/extra/browser/detector.js';
import { createBrowserTool, closeSession } from '../../src/tools/extra/browser.js';
import { tempDir } from '../support/tmp.js';
import { toolContext } from '../support/tool-context.js';
import type { GateRunContext } from '../../src/verify/gates.js';

describe('browser integration', () => {
  it('fixture app gate fails before fix, then passes after fix', async () => {
    const backend = await detectBrowserBackend();
    if (!backend.backend) {
      console.log('Skipping browser integration test: no browser backend available');
      return;
    }

    const fixtureDir = join(process.cwd(), 'test/fixtures/browser-app');
    const indexHtmlPath = join(fixtureDir, 'index.html');
    const originalHtml = await readFile(indexHtmlPath, 'utf8');

    // Start static HTTP server for fixture
    const server = http.createServer((req, res) => {
      const urlPath = req.url === '/' ? 'index.html' : (req.url ?? '').replace(/^\//, '');
      const filePath = join(fixtureDir, urlPath);
      void readFile(filePath)
        .then((content) => {
          res.writeHead(200, {
            'Content-Type': filePath.endsWith('.html') ? 'text/html' : 'text/plain',
          });
          res.end(content);
        })
        .catch(() => {
          res.writeHead(404);
          res.end('Not found');
        });
    });

    await new Promise<void>((resolve) => {
      server.listen(8999, '127.0.0.1', () => {
        resolve();
      });
    });

    try {
      const logsDir = await tempDir('browser-gate-logs-');
      const gateCtx: GateRunContext = {
        cwd: fixtureDir,
        env: {},
        logsDir,
        label: 'test',
        maxCmdTimeoutMs: 30_000,
        redact: (s) => s,
      };

      // 1. Run gate on broken app: must fail
      const resultBefore = await runBrowserGate(
        {
          name: 'fixture-check',
          script: 'e2e/check.yaml',
        },
        gateCtx,
      );

      expect(resultBefore.exitCode).toBe(1);
      expect(resultBefore.failures.length).toBeGreaterThan(0);

      // 2. Fix the broken button in index.html
      const fixedHtml = originalHtml.replace(
        `    function handleSubmit() {
      // BUG: intentional error
      console.error("Uncaught TypeError: handler failed");
      const statusEl = document.getElementById("status-message");
      statusEl.textContent = "Error: Submission failed";
      statusEl.className = "status error";
    }`,
        `    function handleSubmit() {
      const name = document.getElementById("name-input").value;
      const statusEl = document.getElementById("status-message");
      statusEl.textContent = "Submitted Successfully: " + name;
      statusEl.className = "status success";
    }`,
      );

      await writeFile(indexHtmlPath, fixedHtml, 'utf8');

      // 3. Run gate on fixed app: must pass
      const resultAfter = await runBrowserGate(
        {
          name: 'fixture-check',
          script: 'e2e/check.yaml',
        },
        gateCtx,
      );

      expect(resultAfter.exitCode).toBe(0);
      expect(resultAfter.failures).toHaveLength(0);
    } finally {
      // Restore original broken HTML
      await writeFile(indexHtmlPath, originalHtml, 'utf8');
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('reports frontend problems and catches a visual change on a real page', async () => {
    const backend = await detectBrowserBackend();
    if (!backend.backend) {
      console.log('Skipping cockpit integration test: no browser backend available');
      return;
    }

    const title = 'Cockpit';
    const server = http.createServer((_req, res) => {
      if (_req.url === '/missing') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;background:#fff;color:#111;font-family:sans-serif">
        <h1 id="title">${title}</h1>
        <button id="go" onclick="console.error('request failed'); fetch('/missing'); document.getElementById('title').textContent = 'Clicked'">Go</button>
      </body></html>`);
    });
    await new Promise<void>((resolve) => {
      server.listen(8997, '127.0.0.1', () => {
        resolve();
      });
    });

    const root = await tempDir('browser-cockpit-it-');
    const ctx = await toolContext(root);
    const tool = createBrowserTool(
      {
        enabled: true,
        allow: ['localhost', '127.0.0.1', '*.local'],
        headless: true,
        serve_timeout: '60s',
        allow_eval: false,
        live_view: false,
        report_errors: true,
        visual_diff_threshold: 0.1,
        engine: 'chromium' as const,
      },
      {
        // Integration files run in parallel; a private agent-browser session keeps them apart.
        createBackend: (session, headless, launch) =>
          createBrowserBackend(`${session}-cockpit-it`, headless, launch),
      },
    );
    const run = (input: Parameters<typeof tool.run>[0]) => tool.run(input, ctx);

    try {
      await run({ action: 'open', url: 'http://127.0.0.1:8997/' });
      expect((await run({ action: 'visual_check', name: 'cockpit' })).content).toContain(
        'First visual_check',
      );
      const same = await run({ action: 'visual_check', name: 'cockpit' });
      expect(same.isError).toBeFalsy();
      expect(same.content).toContain('No meaningful visual change');

      const clicked = await run({ action: 'click', ref: '#go' });
      expect(clicked.isError).toBeFalsy();
      expect(clicked.content).toContain('Frontend diagnostics after this action');

      await run({ action: 'wait_for', text: 'Clicked' });
      const diag = await run({ action: 'diagnostics' });
      expect(diag.content).toContain('[error] request failed');
      expect(diag.content).toContain('404 GET http://127.0.0.1:8997/missing');

      const changed = await run({ action: 'visual_check', name: 'cockpit' });
      expect(changed.isError).toBe(true);
      expect(changed.content).toContain('The UI moved or changed');

      expect(
        (await run({ action: 'visual_check', name: 'cockpit', update: true })).isError,
      ).toBeFalsy();
      const accepted = await run({ action: 'visual_check', name: 'cockpit' });
      expect(accepted.isError).toBeFalsy();
      expect(accepted.content).toContain('No meaningful visual change');
    } finally {
      await closeSession(ctx.store.runId);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }, 120_000);

  it('refuses disallowed URLs with a clear message and emits browser.denied', async () => {
    const root = await tempDir('browser-tool-root-');
    const ctx = await toolContext(root);
    const tool = createBrowserTool({
      enabled: true,
      allow: ['localhost', '127.0.0.1', '*.local'],
      headless: true,
      serve_timeout: '60s',
      allow_eval: false,
      live_view: false,
      report_errors: false,
      visual_diff_threshold: 0.1,
      engine: 'chromium' as const,
    });

    const res = await tool.run({ action: 'open', url: 'https://evil.com/phishing' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('refused by browser allowlist');
  });

  it('leaves zero orphan browser processes after 20 open/close cycles', async () => {
    const backend = await detectBrowserBackend();
    if (!backend.backend) {
      console.log('Skipping process test: no browser backend available');
      return;
    }

    // Start static HTTP server for fast local requests
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1>test</h1></body></html>');
    });

    await new Promise<void>((resolve) => {
      server.listen(8998, '127.0.0.1', () => {
        resolve();
      });
    });

    try {
      const initialProcList = await execa('ps', ['-ax', '-o', 'pid,command'], { reject: false });
      const countChromium = (stdout: string) =>
        stdout
          .split('\n')
          .filter(
            (l) => l.includes('Google Chrome for Testing') || l.includes('agent-browser-darwin'),
          ).length;
      const countBefore = countChromium(initialProcList.stdout);

      // 20 open/close cycles
      for (let i = 0; i < 20; i++) {
        const session = `cycle-test-${i}-${Date.now()}`;
        const inst = await createBrowserBackend(session, true);
        if (inst) {
          await inst.open('http://127.0.0.1:8998');
          await inst.close();
        }
      }

      // Small delay to allow OS process termination to settle
      await new Promise((r) => setTimeout(r, 1000));

      const finalProcList = await execa('ps', ['-ax', '-o', 'pid,command'], { reject: false });
      const countAfter = countChromium(finalProcList.stdout);

      // There should be no accumulation of zombie/orphan processes
      expect(countAfter).toBeLessThanOrEqual(countBefore + 1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }, 120_000);
});
