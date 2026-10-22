import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeSession, createBrowserTool } from '../../../src/tools/extra/browser.js';
import type {
  BrowserBackend,
  BrowserConsoleMessage,
  BrowserRequest,
} from '../../../src/tools/extra/browser/types.js';
import {
  LAYOUT_PROBE,
  asLayoutReport,
  formatPageCheck,
  type LayoutReport,
} from '../../../src/tools/extra/browser/page-check.js';
import { parseSemantic } from '../../../src/tools/extra/browser/selector.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';
// @ts-expect-error: plain ESM helper without type declarations.
import { findChrome, probe } from '../../../bench/suites/web5/lib/probe.mjs';

const config = {
  enabled: true,
  allow: ['localhost', '127.0.0.1'],
  headless: true,
  serve_timeout: '60s',
  allow_eval: false,
  live_view: false,
  report_errors: false,
  visual_diff_threshold: 0.1,
  engine: 'chromium' as const,
};
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WEB5 = join(dirname(fileURLToPath(import.meta.url)), '../../../bench/suites/web5');

const cleanLayout: LayoutReport = {
  title: 'Shop',
  viewport: { w: 1280, h: 900 },
  scrollWidth: 1280,
  overflow: [],
  overlaps: [],
  brokenImages: [],
  textChars: 120,
};

/** A backend whose page logs `onOpen` messages and requests each time it is opened. */
function pageBackend(over: Partial<BrowserBackend> = {}, layout: unknown = cleanLayout) {
  const calls: string[] = [];
  const logs: BrowserConsoleMessage[] = [{ type: 'error', text: 'from an earlier page' }];
  const reqs: BrowserRequest[] = [{ method: 'GET', url: 'http://localhost/old', status: 500 }];
  const backend: BrowserBackend = {
    name: 'fake',
    open: (url) => {
      calls.push(`open ${url}`);
      logs.push({
        type: 'error',
        text: "TypeError: Cannot read properties of null (reading 'appendChild')",
      });
      logs.push({ type: 'warning', text: 'deprecated API' });
      reqs.push({ method: 'GET', url: 'http://localhost:3000/img/logo.svg', status: 404 });
      return Promise.resolve();
    },
    snapshot: () => Promise.resolve('- button "Save" [ref=e1]'),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    press: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    screenshot: () => Promise.resolve({ base64: PNG, mimeType: 'image/png' }),
    console: () => Promise.resolve([...logs]),
    network: () => Promise.resolve([...reqs]),
    evaluate: (expr) => {
      calls.push(expr === LAYOUT_PROBE ? 'evaluate LAYOUT_PROBE' : `evaluate ${expr}`);
      return Promise.resolve(layout);
    },
    setViewport: (w, h) => {
      calls.push(`viewport ${w}x${h}`);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    ...over,
  };
  return { backend, calls };
}

let ctx: ToolContext | undefined;
async function setup(backend: BrowserBackend) {
  const root = await tempDir('browser-check-');
  const c = await toolContext(root);
  ctx = c;
  const tool = createBrowserTool(config, { createBackend: () => Promise.resolve(backend) });
  return { root, run: (input: Parameters<typeof tool.run>[0]) => tool.run(input, c) };
}

afterEach(async () => {
  if (ctx) await closeSession(ctx.store.runId);
});

describe('parseSemantic', () => {
  it('reads text, label, placeholder and role targets', () => {
    expect(parseSemantic('text=Save changes')).toEqual({ by: 'text', value: 'Save changes' });
    expect(parseSemantic('label="Email"')).toEqual({ by: 'label', value: 'Email' });
    expect(parseSemantic('placeholder=Search')).toEqual({ by: 'placeholder', value: 'Search' });
    expect(parseSemantic('role=button[name="Save"]')).toEqual({
      by: 'role',
      role: 'button',
      name: 'Save',
    });
    expect(parseSemantic('role=link')).toEqual({ by: 'role', role: 'link' });
  });

  it('leaves refs and CSS selectors alone', () => {
    for (const ref of ['@e1', 'e3', '#save', 'button.primary', 'input[name="q"]', 'text='])
      expect(parseSemantic(ref)).toBeNull();
  });
});

describe('formatPageCheck', () => {
  const base = { url: 'http://localhost:3000/', screenshot: '/logs/s.png (1x1, 0 KB)' };

  it('says so when the page is clean, in two lines', () => {
    const out = formatPageCheck({ ...base, console: [], requests: [], layout: cleanLayout });
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('No problems found.');
    expect(out).toContain('viewport 1280x900');
  });

  it('lists only problems, capped, with counts', () => {
    const out = formatPageCheck({
      ...base,
      console: Array.from({ length: 8 }, (_, i) => ({ type: 'error', text: `boom ${i}` })),
      requests: [
        { method: 'GET', url: 'http://localhost:3000/a.png', status: 404 },
        { method: 'GET', url: 'http://localhost:3000/', status: 200 },
      ],
      layout: {
        ...cleanLayout,
        viewport: { w: 375, h: 900 },
        scrollWidth: 960,
        overflow: ['img (+585px)'],
        overlaps: ['h1 overlaps p'],
        brokenImages: ['a.png'],
      },
    });
    expect(out).toContain('Console errors (8):');
    expect(out).toContain('… 3 more');
    expect(out).toContain('Failed requests (1):\n  - 404 GET http://localhost:3000/a.png');
    expect(out).not.toContain('200 GET');
    expect(out).toContain('page is 960px wide in a 375px viewport');
    expect(out).toContain('img (+585px)');
    expect(out).toContain('h1 overlaps p');
    expect(out).toContain('Broken images (1)');
  });

  it('rejects evaluate results that are not layout reports', () => {
    expect(asLayoutReport(null)).toBeNull();
    expect(asLayoutReport({ title: 'x' })).toBeNull();
    expect(asLayoutReport(cleanLayout)).toEqual(cleanLayout);
  });
});

describe('browser check_page action', () => {
  it('loads the URL and reports only this load: console errors, failed requests, screenshot', async () => {
    const { backend, calls } = pageBackend();
    const { run } = await setup(backend);
    const r = await run({ action: 'check_page', url: 'http://localhost:3000/', width: 375 });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      'viewport 375x900',
      'open http://localhost:3000/',
      'evaluate LAYOUT_PROBE',
    ]);
    expect(r.content).toContain(
      "TypeError: Cannot read properties of null (reading 'appendChild')",
    );
    expect(r.content).toContain('404 GET http://localhost:3000/img/logo.svg');
    expect(r.content).not.toContain('from an earlier page');
    expect(r.content).not.toContain('/old');
    expect(r.content).toMatch(/Screenshot: .*browser\/screenshot-.*\.png \(1x1/);
    // Compact: a handful of lines, not a page dump.
    expect(r.content.split('\n').length).toBeLessThan(10);
  });

  it('runs its layout probe even when eval is disabled, and opens repo files', async () => {
    const { backend, calls } = pageBackend();
    const { run, root } = await setup(backend);
    await writeFile(join(root, 'index.html'), '<h1>hi</h1>');
    const r = await run({ action: 'check_page', url: 'index.html' });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toBe(`open ${pathToFileURL(join(root, 'index.html')).href}`);
    expect(calls).toContain('evaluate LAYOUT_PROBE');
  });

  it('refuses files outside the repo and URLs outside the allowlist', async () => {
    const { backend, calls } = pageBackend();
    const { run } = await setup(backend);
    expect((await run({ action: 'check_page', url: '../../etc/passwd' })).isError).toBe(true);
    const r = await run({ action: 'check_page', url: 'https://example.com/' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('allowlist');
    expect(calls).toEqual([]);
  });

  it('still reports console and network when the backend cannot evaluate', async () => {
    const backend: BrowserBackend = { ...pageBackend().backend };
    delete backend.evaluate;
    const { run } = await setup(backend);
    const r = await run({ action: 'check_page', url: 'http://localhost:3000/' });
    expect(r.content).toContain('Console errors (1)');
    expect(r.content).toContain('Layout checks unavailable');
  });

  it('explains a timed-out element action and shows a snapshot to pick from', async () => {
    const { backend } = pageBackend({
      click: () =>
        Promise.reject(new Error('locator.click: Timeout 10000ms exceeded.\nCall log: ...')),
    });
    const { run } = await setup(backend);
    const r = await run({ action: 'click', ref: 'text=Save' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no visible, enabled element matched text=Save in time');
    expect(r.content).toContain('- button "Save" [ref=e1]');
    expect(r.content).not.toContain('Call log');
  });
});

// The probe on real pages, in headless Chrome when this machine has one.
describe.skipIf(!(findChrome as () => string | null)())('LAYOUT_PROBE in Chrome', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const copy = (task: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'layout-probe-'));
    dirs.push(d);
    cpSync(join(WEB5, task, 'repo/public'), d, { recursive: true });
    return join(d, 'index.html');
  };
  type Probe = (page: string, width: number, expr: string) => { extra: unknown };

  it('finds what overflows a narrow viewport', () => {
    const page = copy('task-02-fix-mobile-overflow');
    const report = asLayoutReport((probe as Probe)(page, 500, LAYOUT_PROBE).extra);
    expect(report?.scrollWidth).toBeGreaterThan(report?.viewport.w ?? 0);
    expect(report?.overflow.join(' ')).toMatch(/img|section\.card|code/);
  }, 60_000);

  it('finds broken images', () => {
    const page = copy('task-05-frontend-console-errors');
    expect(existsSync(page)).toBe(true);
    const report = asLayoutReport((probe as Probe)(page, 1024, LAYOUT_PROBE).extra);
    expect(report?.brokenImages).toEqual(['img/logo.svg']);
    expect(report?.overflow).toEqual([]);
  }, 60_000);
});
