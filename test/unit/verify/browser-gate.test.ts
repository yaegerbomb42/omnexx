import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserBackend } from '../../../src/tools/extra/browser/types.js';
import { parseBrowserGateScript, runBrowserGate } from '../../../src/verify/browser-gate.js';
import type { GateRunContext } from '../../../src/verify/gates.js';

describe('browser gate parser', () => {
  it('parses valid YAML gate script', () => {
    const yaml = `steps:
  - action: open
    url: http://localhost:3000
  - action: click
    selector: "@btn"
  - action: expect_text
    text: Hello
`;
    const parsed = parseBrowserGateScript(yaml);
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toEqual({ action: 'open', url: 'http://localhost:3000' });
    expect(parsed.steps[1]).toEqual({ action: 'click', selector: '@btn' });
    expect(parsed.steps[2]).toEqual({ action: 'expect_text', text: 'Hello' });
  });

  it('parses simple yaml scalars', () => {
    const yaml = `
steps:
  - action: wait_ms
    ms: 500
  - action: expect_no_console_errors
`;
    const parsed = parseBrowserGateScript(yaml);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]).toEqual({ action: 'wait_ms', ms: 500 });
    expect(parsed.steps[1]).toEqual({ action: 'expect_no_console_errors' });
  });

  it('rejects invalid actions', () => {
    const invalid = `steps:
  - action: unknown_action
    foo: bar
`;
    expect(() => parseBrowserGateScript(invalid)).toThrow();
  });
});

describe('runBrowserGate with a fake backend', () => {
  function fakeBackend(page: string, consoleMsgs: { type: string; text: string }[] = []) {
    const calls: string[] = [];
    const backend: BrowserBackend = {
      name: 'fake',
      open: (url) => Promise.resolve(void calls.push(`open ${url}`)),
      snapshot: () => Promise.resolve(page),
      click: (ref) => Promise.resolve(void calls.push(`click ${ref}`)),
      type: (ref, text) => Promise.resolve(void calls.push(`type ${ref} ${text}`)),
      press: () => Promise.resolve(),
      scroll: () => Promise.resolve(),
      screenshot: () => Promise.resolve({ base64: '', mimeType: 'image/png' }),
      console: () => Promise.resolve(consoleMsgs),
      close: () => Promise.resolve(void calls.push('close')),
    };
    return { backend, calls };
  }

  async function setup(script: string) {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-bgate-'));
    await writeFile(join(dir, 'check.yaml'), script);
    const ctx: GateRunContext = {
      cwd: dir,
      env: {},
      logsDir: dir,
      label: 'c1',
      maxCmdTimeoutMs: 10_000,
      redact: (s) => s,
    };
    return { dir, ctx };
  }

  const script = `steps:
  - action: open
    url: http://localhost:3000
  - action: type
    selector: "@e1"
    text: hi
  - action: click
    selector: "@e2"
  - action: wait_ms
    ms: 1
  - action: expect_text
    text: Saved
  - action: expect_selector
    selector: "#save"
  - action: expect_no_console_errors
`;

  it('passes every step, closes the browser and writes a log', async () => {
    const { dir, ctx } = await setup(script);
    const { backend, calls } = fakeBackend('button "save" [ref=e2]\nSaved');
    const r = await runBrowserGate({ name: 'ui', script: 'check.yaml' }, ctx, backend);
    expect(r.exitCode).toBe(0);
    expect(r.tests).toEqual({ total: 7, passed: 7, failed: 0, skipped: 0 });
    expect(calls).toEqual(['open http://localhost:3000', 'type @e1 hi', 'click @e2', 'close']);
    expect(await readFile(r.logFile, 'utf8')).toContain('7/7 passed');
    await rm(dir, { recursive: true, force: true });
  });

  it('stops at the first failing step and skips the rest', async () => {
    const { dir, ctx } = await setup(script);
    const { backend, calls } = fakeBackend('nothing here');
    const r = await runBrowserGate({ name: 'ui', script: 'check.yaml' }, ctx, backend);
    expect(r.exitCode).toBe(1);
    expect(r.failures.map((f) => f.id)).toEqual(['ui:step_5_expect_text']);
    expect(r.tests).toEqual({ total: 7, passed: 4, failed: 1, skipped: 2 });
    expect(calls.at(-1)).toBe('close');
    await rm(dir, { recursive: true, force: true });
  });

  it('reports console errors and missing selectors', async () => {
    const { dir, ctx } = await setup(`steps:
  - action: expect_no_console_errors
`);
    const { backend } = fakeBackend('', [{ type: 'error', text: 'boom' }]);
    const r = await runBrowserGate({ name: 'ui', script: 'check.yaml' }, ctx, backend);
    expect(r.failures[0]?.message).toContain('boom');

    await writeFile(
      join(dir, 'check.yaml'),
      'steps:\n  - action: expect_selector\n    selector: "#gone"\n',
    );
    const r2 = await runBrowserGate(
      { name: 'ui', script: 'check.yaml' },
      ctx,
      fakeBackend('').backend,
    );
    expect(r2.failures[0]?.id).toBe('ui:step_1_expect_selector');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails cleanly on a missing or invalid script', async () => {
    const { dir, ctx } = await setup('steps:\n  - action: nope\n');
    const { backend } = fakeBackend('');
    const missing = await runBrowserGate({ name: 'ui', script: 'absent.yaml' }, ctx, backend);
    expect(missing.failures[0]?.id).toBe('ui:missing_script');
    const bad = await runBrowserGate(
      { name: 'ui', script: 'check.yaml', level: 'must-pass' },
      ctx,
      backend,
    );
    expect(bad.failures[0]?.id).toBe('ui:syntax_error');
    expect(bad.level).toBe('must-pass');
    await rm(dir, { recursive: true, force: true });
  });

  it('parses TOML gate scripts', () => {
    const parsed = parseBrowserGateScript(
      '[[steps]]\naction = "open"\nurl = "http://localhost:1"\n',
    );
    expect(parsed.steps[0]).toEqual({ action: 'open', url: 'http://localhost:1' });
  });

  it('runs a login flow with fill, select, wait_for and expect_url', async () => {
    const { dir, ctx } = await setup(`steps:
  - action: open
    url: \${URL}/login
  - action: fill
    selector: "#user"
    text: bob
  - action: select
    selector: "#plan"
    value: Large
  - action: click
    selector: "#submit"
  - action: wait_for
    text: Welcome
    timeout_ms: 500
  - action: wait_for
    selector: "#logout"
  - action: expect_url
    url: \${URL}/home
`);
    const { backend, calls } = fakeBackend('');
    let url = '';
    backend.open = (u) => Promise.resolve(void (url = u));
    backend.fill = (sel, text) => Promise.resolve(void calls.push(`fill ${sel} ${text}`));
    backend.select = (sel, v) => Promise.resolve(void calls.push(`select ${sel} ${v}`));
    backend.waitFor = (t, ms) =>
      Promise.resolve(void calls.push(`wait ${JSON.stringify(t)} ${ms}`));
    backend.getUrl = () => Promise.resolve(url.replace('/login', '/home'));
    const r = await runBrowserGate(
      { name: 'ui', script: 'check.yaml', url: 'http://localhost:9' },
      ctx,
      backend,
    );
    expect(r.failures).toEqual([]);
    expect(calls).toEqual([
      'fill #user bob',
      'select #plan Large',
      'click #submit',
      'wait {"text":"Welcome"} 500',
      'wait {"selector":"#logout"} 10000',
      'close',
    ]);

    backend.getUrl = () => Promise.resolve('http://localhost:9/login');
    const wrong = await runBrowserGate(
      { name: 'ui', script: 'check.yaml', url: 'http://localhost:9' },
      ctx,
      backend,
    );
    expect(wrong.failures[0]?.message).toContain(
      'Expected URL containing "http://localhost:9/home"',
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('fails new steps clearly on a backend without them', async () => {
    const { dir, ctx } = await setup('');
    const { backend } = fakeBackend('');
    for (const step of [
      'action: fill\n    selector: "#a"\n    text: x',
      'action: select\n    selector: "#a"\n    value: x',
      'action: wait_for\n    text: x',
      'action: expect_url\n    url: /x',
    ]) {
      await writeFile(join(dir, 'check.yaml'), `steps:\n  - ${step}\n`);
      const r = await runBrowserGate({ name: 'ui', script: 'check.yaml' }, ctx, backend);
      expect(r.failures[0]?.message).toContain('fake browser backend does not support');
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a wait_for with both or neither of selector and text', () => {
    expect(() => parseBrowserGateScript('steps:\n  - action: wait_for\n')).toThrow();
    expect(() =>
      parseBrowserGateScript('steps:\n  - action: wait_for\n    text: a\n    selector: "#b"\n'),
    ).toThrow();
  });
});
