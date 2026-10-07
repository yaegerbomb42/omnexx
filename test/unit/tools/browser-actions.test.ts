import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeSession, createBrowserTool } from '../../../src/tools/extra/browser.js';
import type { BrowserBackend } from '../../../src/tools/extra/browser/types.js';
import { pollUntil } from '../../../src/tools/extra/browser/wait.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

const config = {
  enabled: true,
  allow: ['localhost', '127.0.0.1'],
  headless: true,
  serve_timeout: '60s',
  allow_eval: false,
};

/** 1x1 PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fullBackend(over: Partial<BrowserBackend> = {}) {
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args.map(String)].join(' '));
      return Promise.resolve();
    };
  const backend: BrowserBackend = {
    name: 'fake',
    open: log('open'),
    snapshot: () => Promise.resolve('- button "Go" [ref=e1]'),
    click: log('click'),
    type: log('type'),
    press: log('press'),
    scroll: log('scroll'),
    screenshot: () => Promise.resolve({ base64: PNG, mimeType: 'image/png' }),
    console: () =>
      Promise.resolve(Array.from({ length: 60 }, (_, i) => ({ type: 'log', text: `m${i}` }))),
    close: log('close'),
    waitFor: (t, ms) => log('waitFor')(JSON.stringify(t), ms),
    waitForLoad: log('waitForLoad'),
    fill: log('fill'),
    select: log('select'),
    setChecked: log('setChecked'),
    upload: log('upload'),
    hover: log('hover'),
    getText: (ref) => Promise.resolve(`text of ${ref}`),
    getUrl: () => Promise.resolve('http://localhost:3000/done'),
    evaluate: () => Promise.resolve({ ok: 1 }),
    network: () =>
      Promise.resolve([
        { method: 'GET', url: 'http://localhost:3000/', status: 200, resourceType: 'document' },
        { method: 'POST', url: 'http://localhost:3000/api', status: 500 },
        { method: 'GET', url: 'http://localhost:3000/gone' },
      ]),
    tabs: () =>
      Promise.resolve([
        { id: 't1', url: 'http://localhost:3000/', title: 'Home', active: false },
        { id: 't2', url: 'http://localhost:3000/b', title: '', active: true },
      ]),
    switchTab: log('switchTab'),
    newTab: log('newTab'),
    closeTab: log('closeTab'),
    ...over,
  };
  return { backend, calls };
}

/** Only the required methods: every optional action must report itself unsupported. */
function coreBackend(): BrowserBackend {
  const done = () => Promise.resolve();
  return {
    name: 'fake',
    open: done,
    snapshot: () => Promise.resolve(''),
    click: done,
    type: done,
    press: done,
    scroll: done,
    screenshot: () => Promise.resolve({ base64: PNG, mimeType: 'image/png' }),
    console: () => Promise.resolve([]),
    close: done,
  };
}

let ctx: ToolContext;

async function setup(backend: BrowserBackend, cfg: Partial<typeof config> = {}) {
  const root = await tempDir('browser-actions-');
  ctx = await toolContext(root);
  const tool = createBrowserTool(
    { ...config, ...cfg },
    { createBackend: () => Promise.resolve(backend) },
  );
  return { tool, root, run: (input: Parameters<typeof tool.run>[0]) => tool.run(input, ctx) };
}

afterEach(async () => {
  await closeSession(ctx.store.runId);
});

describe('browser tool actions with a fake backend', () => {
  it('opens, waits for the page to settle, and returns a snapshot', async () => {
    const { backend, calls } = fullBackend();
    const { run } = await setup(backend);
    const r = await run({ action: 'open', url: 'http://localhost:3000' });
    expect(r.content).toContain('[ref=e1]');
    expect(calls).toEqual(['open http://localhost:3000', 'waitForLoad 5000']);
  });

  it('drives form controls', async () => {
    const { backend, calls } = fullBackend();
    const { run, root } = await setup(backend);
    await writeFile(join(root, 'logo.png'), 'x');
    expect((await run({ action: 'fill', ref: '@e2', text: 'bob' })).content).toBe('Filled @e2');
    expect((await run({ action: 'type', ref: '@e2', text: '!' })).content).toBe('Typed into @e2');
    expect((await run({ action: 'select', ref: '@e3', value: 'Large' })).content).toBe(
      'Selected "Large" in @e3',
    );
    expect((await run({ action: 'check', ref: '@e4' })).content).toBe('Checked @e4');
    expect((await run({ action: 'uncheck', ref: '@e4' })).content).toBe('Unchecked @e4');
    expect((await run({ action: 'hover', ref: '@e5' })).content).toBe('Hovering over @e5');
    expect((await run({ action: 'upload', ref: '@e6', path: 'logo.png' })).content).toBe(
      'Uploaded logo.png to @e6',
    );
    expect((await run({ action: 'click', ref: '@e7' })).content).toBe('Clicked @e7');
    expect(calls).toEqual([
      'fill @e2 bob',
      'type @e2 !',
      'select @e3 Large',
      'setChecked @e4 true',
      'setChecked @e4 false',
      'hover @e5',
      `upload @e6 ${join(root, 'logo.png')}`,
      'click @e7',
      'waitForLoad 5000',
    ]);
  });

  it('refuses to upload a file outside the repo', async () => {
    const { backend, calls } = fullBackend();
    const { run } = await setup(backend);
    const r = await run({ action: 'upload', ref: '@e6', path: '/etc/passwd' });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('waits for an element or text, and explains a timeout with a snapshot', async () => {
    const { backend, calls } = fullBackend();
    const { run } = await setup(backend);
    expect((await run({ action: 'wait_for', ref: '@e9' })).content).toBe('@e9 is on the page');
    await run({ action: 'wait_for', text: 'Thanks', timeout_ms: 50 });
    expect(calls).toEqual(['waitFor {"selector":"@e9"} 10000', 'waitFor {"text":"Thanks"} 50']);

    const slow = fullBackend({ waitFor: () => Promise.reject(new Error('timed out')) });
    const s = await setup(slow.backend);
    await closeSession(ctx.store.runId);
    const r = await s.run({ action: 'wait_for', text: 'Thanks', timeout_ms: 50 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('"Thanks" did not appear within 50ms');
    expect(r.content).toContain('[ref=e1]');
    expect((await s.run({ action: 'wait_for' })).content).toContain('requires "ref"');
  });

  it('reads text, url, network and tabs', async () => {
    const { backend, calls } = fullBackend();
    const { run } = await setup(backend);
    expect((await run({ action: 'get_text', ref: '@e1' })).content).toBe('text of @e1');
    expect((await run({ action: 'get_url' })).content).toBe('http://localhost:3000/done');
    const net = (await run({ action: 'network' })).content;
    expect(net).toContain('Requests (3, 2 failed)');
    expect(net).toContain('500 POST http://localhost:3000/api');
    expect(net).toContain('FAILED GET http://localhost:3000/gone');
    const tabs = (await run({ action: 'tabs' })).content;
    expect(tabs).toContain('* t2  http://localhost:3000/b');
    expect((await run({ action: 'switch_tab', tab: 't1' })).content).toBe(
      'Switched to tab t1 (http://localhost:3000/done)',
    );
    expect((await run({ action: 'new_tab', url: 'http://localhost:3000/x' })).content).toContain(
      'in a new tab',
    );
    expect((await run({ action: 'close_tab' })).content).toBe('Closed tab (current)');
    expect((await run({ action: 'new_tab', url: 'https://evil.com' })).isError).toBe(true);
    expect((await run({ action: 'switch_tab' })).isError).toBe(true);
    expect(calls).toEqual([
      'switchTab t1',
      'newTab http://localhost:3000/x',
      'waitForLoad 5000',
      'closeTab undefined',
    ]);
  });

  it('keeps eval off unless the config allows it', async () => {
    const { backend } = fullBackend();
    const off = await setup(backend);
    const r = await off.run({ action: 'eval', expression: '1' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('allow_eval');
    await closeSession(ctx.store.runId);

    const on = await setup(backend, { allow_eval: true });
    expect((await on.run({ action: 'eval', expression: 'x' })).content).toBe('{"ok":1}');
    expect((await on.run({ action: 'eval' })).isError).toBe(true);
  });

  it('caps console output', async () => {
    const { backend } = fullBackend();
    const { run } = await setup(backend);
    const out = (await run({ action: 'console' })).content;
    expect(out).toContain('Console messages (60)');
    expect(out).toContain('… 10 earlier entries omitted');
    expect(out).not.toContain('[log] m9\n');
    expect(out).toContain('[log] m59');
  });

  it('saves screenshots under the run logs, not the repo', async () => {
    const { backend } = fullBackend();
    const { run, root } = await setup(backend);
    const r = await run({ action: 'screenshot' });
    const path = /saved to (\S+)/.exec(r.content)?.[1] ?? '';
    expect(path.startsWith(ctx.store.logsDir)).toBe(true);
    expect(path.startsWith(root)).toBe(false);
    expect(r.content).toContain('1x1');
    expect(r.content).toContain('of http://localhost:3000/done');
    expect((await readFile(path)).toString('base64')).toBe(PNG);
  });

  it('reports actions the backend cannot do', async () => {
    const { run } = await setup(coreBackend());
    const cases = [
      { action: 'fill', ref: '@e1', text: 'x' },
      { action: 'select', ref: '@e1', value: 'x' },
      { action: 'check', ref: '@e1' },
      { action: 'hover', ref: '@e1' },
      { action: 'get_text', ref: '@e1' },
      { action: 'get_url' },
      { action: 'network' },
      { action: 'tabs' },
      { action: 'switch_tab', tab: '1' },
      { action: 'new_tab', url: 'http://localhost:1' },
      { action: 'close_tab' },
      { action: 'wait_for', text: 'x' },
    ] as const;
    for (const c of cases) {
      const r = await run(c);
      expect(r.isError, c.action).toBe(true);
      expect(r.content).toContain('not supported by the fake browser backend');
    }
  });

  it('validates required parameters', async () => {
    const { run } = await setup(fullBackend().backend);
    expect((await run({ action: 'click' })).content).toContain('requires "ref"');
    expect((await run({ action: 'fill', ref: '@e1' })).content).toContain('"text"');
    expect((await run({ action: 'select', ref: '@e1' })).content).toContain('"value"');
    expect((await run({ action: 'upload', ref: '@e1' })).content).toContain('"path"');
    expect((await run({ action: 'open' })).content).toContain('requires "url"');
  });
});

describe('stale refs and failures', () => {
  it('retries a click once after a fresh snapshot when the ref is stale', async () => {
    let attempts = 0;
    let snapshots = 0;
    const { backend } = fullBackend({
      click: () =>
        ++attempts === 1 ? Promise.reject(new Error('Unknown ref: e7')) : Promise.resolve(),
      snapshot: () => {
        snapshots++;
        return Promise.resolve('tree');
      },
    });
    const { run } = await setup(backend);
    const r = await run({ action: 'click', ref: '@e7' });
    expect(r.content).toBe('Clicked @e7 (after refreshing a stale ref)');
    expect(attempts).toBe(2);
    expect(snapshots).toBe(1);
  });

  it('tells the model to take a snapshot when the ref stays stale', async () => {
    const { backend } = fullBackend({
      type: () => Promise.reject(new Error('Unknown ref: e7')),
    });
    const { run } = await setup(backend);
    const r = await run({ action: 'type', ref: '@e7', text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('ref @e7 not found on the page');
    expect(r.content).toContain('take a snapshot');
    expect(r.content).toContain('[ref=e1]');
  });

  it('does not retry real failures or CSS selectors', async () => {
    let attempts = 0;
    const { backend } = fullBackend({
      click: () => Promise.reject(new Error(`element is disabled ${++attempts}`)),
    });
    const { run } = await setup(backend);
    expect((await run({ action: 'click', ref: '@e1' })).content).toBe(
      'browser click failed: element is disabled 1',
    );
    expect(attempts).toBe(1);
  });

  it('closes the session when the browser itself dies', async () => {
    const { backend, calls } = fullBackend({
      snapshot: () => Promise.reject(new Error('Target page, context or browser has been closed')),
    });
    const { run } = await setup(backend);
    const r = await run({ action: 'snapshot' });
    expect(r.content).toContain('session was closed');
    expect(calls).toContain('close');
  });
});

describe('pollUntil', () => {
  it('resolves once the check passes and times out otherwise', async () => {
    let n = 0;
    await pollUntil(() => Promise.resolve(++n >= 3), 1_000, 'x', 1);
    expect(n).toBe(3);
    await expect(pollUntil(() => Promise.reject(new Error('no')), 5, 'thing', 1)).rejects.toThrow(
      'timed out after 5ms waiting for thing',
    );
  });
});
