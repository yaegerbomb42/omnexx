import { existsSync } from 'node:fs';
import { readEvents } from '../../../src/core/events.js';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePng } from '../../../src/browser/png.js';
import { closeSession, createBrowserTool } from '../../../src/tools/extra/browser.js';
import type { DevServerLike } from '../../../src/tools/extra/browser/manager.js';
import type {
  BrowserBackend,
  BrowserConsoleMessage,
  BrowserRequest,
} from '../../../src/tools/extra/browser/types.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

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
type BrowserConfig = typeof config & { serve?: string; serve_port?: number };

type Pixel = readonly [number, number, number];

const png = (width: number, height: number, pixel: (x: number, y: number) => Pixel): string => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([...pixel(x, y), 255], (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, data }).toString('base64');
};

const WHITE = png(10, 10, () => [255, 255, 255]);
const ONE_DARK_PIXEL = png(10, 10, (x, y) => (x === 3 && y === 4 ? [0, 0, 0] : [255, 255, 255]));

interface FakeState {
  console: BrowserConsoleMessage[];
  network: BrowserRequest[];
  shot: string;
  viewport: [number, number] | undefined;
  calls: string[];
  clearedConsole: number;
  clearedNetwork: number;
  onOpen?: () => void;
}

const state: FakeState = {
  console: [],
  network: [],
  shot: WHITE,
  viewport: undefined,
  calls: [],
  clearedConsole: 0,
  clearedNetwork: 0,
};

function resetState(): void {
  state.console = [];
  state.network = [];
  state.shot = WHITE;
  state.viewport = undefined;
  state.calls = [];
  state.clearedConsole = 0;
  state.clearedNetwork = 0;
  delete state.onOpen;
}

function backend(over: Partial<BrowserBackend> = {}): BrowserBackend {
  const log =
    (name: string) =>
    (...args: unknown[]): Promise<void> => {
      state.calls.push([name, ...args.map(String)].join(' '));
      return Promise.resolve();
    };
  return {
    name: 'fake',
    open: (url) => {
      state.calls.push(`open ${url}`);
      state.onOpen?.();
      return Promise.resolve();
    },
    snapshot: () => Promise.resolve('- button "Go" [ref=e1]'),
    click: () => {
      state.calls.push('click');
      return Promise.resolve();
    },
    type: log('type'),
    press: log('press'),
    scroll: log('scroll'),
    screenshot: () => Promise.resolve({ base64: state.shot, mimeType: 'image/png' }),
    screenshotElement: (ref) => {
      state.calls.push(`screenshotElement ${ref}`);
      return Promise.resolve({ base64: state.shot, mimeType: 'image/png' });
    },
    setViewport: (width, height) => {
      state.viewport = [width, height];
      return Promise.resolve();
    },
    console: () => Promise.resolve(state.console),
    clearConsole: () => {
      state.clearedConsole++;
      state.console = [];
      return Promise.resolve();
    },
    network: () => Promise.resolve(state.network),
    clearNetwork: () => {
      state.clearedNetwork++;
      state.network = [];
      return Promise.resolve();
    },
    getUrl: () => Promise.resolve('http://localhost:3000/'),
    close: () => {
      state.calls.push('close');
      return Promise.resolve();
    },
    ...over,
  };
}

interface FakeDevServerFactory {
  create: (command: string, port: number | undefined) => DevServerLike;
  starts: { command: string; port?: number }[];
  stops: number;
}

function devServers(fail = false): FakeDevServerFactory {
  const factory: FakeDevServerFactory = {
    starts: [],
    stops: 0,
    create: (command, port) => {
      factory.starts.push(port === undefined ? { command } : { command, port });
      let running = false;
      return {
        start: () => {
          if (fail) return Promise.reject(new Error('boom'));
          running = true;
          return Promise.resolve({
            running,
            command,
            ...(port !== undefined ? { port } : {}),
            output: 'VITE ready',
          });
        },
        stop: () => {
          factory.stops++;
          running = false;
          return Promise.resolve();
        },
        status: () => ({
          running,
          command,
          ...(port !== undefined ? { port } : {}),
          output: running ? 'VITE ready' : '',
        }),
      };
    },
  };
  return factory;
}

let ctx: ToolContext;

async function setup(
  backendOverride: BrowserBackend,
  cfg: Partial<BrowserConfig> = {},
  factory?: FakeDevServerFactory,
) {
  const root = await tempDir('browser-cockpit-');
  ctx = await toolContext(root);
  const tool = createBrowserTool(
    { ...config, ...cfg },
    {
      createBackend: () => Promise.resolve(backendOverride),
      ...(factory ? { createDevServer: factory.create } : {}),
    },
  );
  return { tool, root, run: (input: Parameters<typeof tool.run>[0]) => tool.run(input, ctx) };
}

afterEach(async () => {
  await closeSession(ctx.store.runId);
  resetState();
});

const events = async () => readEvents(ctx.store.eventsPath);

describe('diagnostics and console/network inspection', () => {
  it('reports console errors, warnings and failed requests with an event', async () => {
    state.console = [
      { type: 'log', text: 'noise' },
      { type: 'error', text: 'fetch failed', location: 'app.js:4:2' },
      { type: 'warning', text: 'deprecated' },
    ];
    state.network = [
      { method: 'GET', url: 'http://localhost:3000/', status: 200 },
      { method: 'POST', url: 'http://localhost:3000/api', status: 500 },
    ];
    const { run } = await setup(backend());

    const r = await run({ action: 'diagnostics' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Browser diagnostics for http://localhost:3000/');
    expect(r.content).toContain('1 console error, 1 failed request, 1 warning');
    expect(r.content).toContain('[error] fetch failed (app.js:4:2)');
    expect(r.content).toContain('500 POST http://localhost:3000/api');

    const emitted = (await events()).filter((e) => e.type === 'browser.diagnostics');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.action).toBe('diagnostics');
    expect(emitted[0]?.errors).toBe(1);
    expect(emitted[0]?.failedRequests).toBe(1);
  });

  it('says so when the page is clean', async () => {
    const { run } = await setup(backend());
    const r = await run({ action: 'diagnostics' });
    expect(r.content).toBe(
      'Browser diagnostics for http://localhost:3000/: no console errors and no failed requests.',
    );
  });

  it('filters console output by level and clears the buffer', async () => {
    state.console = [
      { type: 'log', text: 'hello' },
      { type: 'warning', text: 'careful' },
      { type: 'error', text: 'broken' },
      { type: 'pageerror', text: 'crashed' },
    ];
    const { run } = await setup(backend());

    const errors = await run({ action: 'console', level: 'error' });
    expect(errors.content).toContain('matching error');
    expect(errors.content).toContain('[error] broken');
    expect(errors.content).toContain('[pageerror] crashed');
    expect(errors.content).not.toContain('[warning] careful');
    expect(errors.content).not.toContain('[log] hello');

    const warnings = await run({ action: 'console', level: 'warning' });
    expect(warnings.content).toContain('[warning] careful');
    expect(warnings.content).toContain('[error] broken');
    expect(warnings.content).not.toContain('[log] hello');

    const cleared = await run({ action: 'console', clear: true });
    expect(cleared.content).toBe('Console messages cleared.');
    expect(state.clearedConsole).toBe(1);
    expect(state.console).toEqual([]);
    expect((await run({ action: 'console' })).content).toBe('No console messages recorded.');
  });

  it('filters network failures and clears the log', async () => {
    state.network = [
      { method: 'GET', url: 'http://localhost:3000/', status: 200 },
      { method: 'GET', url: 'http://localhost:3000/missing', status: 404 },
      { method: 'GET', url: 'http://localhost:3000/offline', failure: 'ECONNREFUSED' },
    ];
    const { run } = await setup(backend());

    const failed = await run({ action: 'network', failed_only: true });
    expect(failed.content).toContain('Failed requests (2):');
    expect(failed.content).toContain('404 GET http://localhost:3000/missing');
    expect(failed.content).toContain('FAILED (ECONNREFUSED) GET http://localhost:3000/offline');
    expect(failed.content).not.toContain('200 GET');

    const all = await run({ action: 'network', limit: 2 });
    expect(all.content).toContain('Requests (3, 2 failed):');
    expect(all.content).toContain('… 1 earlier entries omitted');

    expect((await run({ action: 'network', clear: true })).content).toBe('Network log cleared.');
    expect(state.clearedNetwork).toBe(1);
    expect((await run({ action: 'network' })).content).toBe('No network requests recorded.');
  });

  it('reports unsupported clearing for a backend without buffers', async () => {
    const noClear = backend();
    delete noClear.clearConsole;
    delete noClear.clearNetwork;
    const { run } = await setup(noClear);
    expect((await run({ action: 'console', clear: true })).content).toContain(
      'not supported by the fake browser backend',
    );
    expect((await run({ action: 'network', clear: true })).content).toContain(
      'not supported by the fake browser backend',
    );
  });
});

describe('automatic diagnostics after page-changing actions', () => {
  it('appends only problems that appeared during the action, once', async () => {
    state.console = [{ type: 'log', text: 'loaded' }];
    state.onOpen = () => {
      state.console.push({ type: 'error', text: 'boom' });
      state.network.push({ method: 'GET', url: 'http://localhost:3000/api', status: 500 });
    };
    const { run } = await setup(backend(), { report_errors: true });

    const first = await run({ action: 'open', url: 'http://localhost:3000/' });
    expect(first.content).toContain('Opened http://localhost:3000/');
    expect(first.content).toContain(
      'Frontend diagnostics after this action: 1 console error, 1 failed request',
    );
    expect(first.content).toContain('[error] boom');
    expect(first.content).toContain('500 GET http://localhost:3000/api');

    // The same buffered entries are not reported again by a later action.
    const second = await run({ action: 'click', ref: '@e1' });
    expect(second.content).toBe('Clicked @e1');

    const emitted = (await events()).filter((e) => e.type === 'browser.diagnostics');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.action).toBe('open');
  });

  it('stays quiet when report_errors is off', async () => {
    state.onOpen = () => {
      state.console.push({ type: 'error', text: 'boom' });
    };
    const { run } = await setup(backend(), { report_errors: false });
    const r = await run({ action: 'open', url: 'http://localhost:3000/' });
    expect(r.content).not.toContain('Frontend diagnostics');
    expect((await events()).filter((e) => e.type === 'browser.diagnostics')).toHaveLength(0);
  });

  it('picks up problems from clear-then-repopulate backends', async () => {
    state.onOpen = () => {
      state.console.push({ type: 'error', text: 'first' });
    };
    const { run } = await setup(backend(), { report_errors: true });
    await run({ action: 'open', url: 'http://localhost:3000/' });
    await run({ action: 'console', clear: true });
    state.console.push({ type: 'error', text: 'second' });
    const r = await run({ action: 'click', ref: '@e1' });
    expect(r.content).toContain('[error] second');
    expect(r.content).not.toContain('[error] first');
  });
});

describe('visual checks', () => {
  it('stores the first screenshot as the baseline under the run logs', async () => {
    const { run, root } = await setup(backend());
    const r = await run({ action: 'visual_check', name: 'home' });
    expect(r.content).toContain('First visual_check for "home": baseline saved (10x10)');
    const baseline = /to (\S+)\. Change/.exec(r.content)?.[1] ?? '';
    expect(baseline.startsWith(ctx.store.logsDir)).toBe(true);
    expect(baseline.startsWith(root)).toBe(false);
    expect(existsSync(baseline)).toBe(true);

    const visual = (await events()).filter((e) => e.type === 'browser.visual');
    expect(visual).toHaveLength(1);
    expect(visual[0]?.action).toBe('baseline');
    expect(visual[0]?.name).toBe('home');
    expect(visual[0]?.width).toBe(10);
  });

  it('passes an unchanged page and fails a changed one with a diff image', async () => {
    const { run } = await setup(backend());
    await run({ action: 'visual_check', name: 'home' });

    const same = await run({ action: 'visual_check', name: 'home' });
    expect(same.isError).toBeFalsy();
    expect(same.content).toContain('No meaningful visual change');
    expect(same.content).toContain('0.00% of 100 pixels changed');

    state.shot = ONE_DARK_PIXEL;
    const changed = await run({ action: 'visual_check', name: 'home' });
    expect(changed.isError).toBe(true);
    expect(changed.content).toContain('1.00% of 100 pixels changed');
    expect(changed.content).toContain('The UI moved or changed');
    const diff = /Diff \(red = changed\): (\S+)/.exec(changed.content)?.[1] ?? '';
    expect(diff.startsWith(ctx.store.logsDir)).toBe(true);
    expect(existsSync(diff)).toBe(true);

    const visual = (await events()).filter((e) => e.type === 'browser.visual');
    expect(visual.map((e) => e.action)).toEqual(['baseline', 'compare', 'compare']);
    expect(visual[2]?.pass).toBe(false);
    expect(visual[2]?.diff).toBe(diff);
  });

  it('honours a per-call threshold', async () => {
    const { run } = await setup(backend());
    await run({ action: 'visual_check', name: 'home' });
    state.shot = ONE_DARK_PIXEL;
    const strict = await run({ action: 'visual_check', name: 'home' });
    expect(strict.isError).toBe(true);
    const lenient = await run({ action: 'visual_check', name: 'home', threshold: 5 });
    expect(lenient.isError).toBeFalsy();
    expect(lenient.content).toContain('No meaningful visual change');
  });

  it('replaces the baseline when asked, so intended changes stick', async () => {
    const { run } = await setup(backend());
    await run({ action: 'visual_check', name: 'home' });
    state.shot = ONE_DARK_PIXEL;
    expect((await run({ action: 'visual_check', name: 'home' })).isError).toBe(true);

    const updated = await run({ action: 'visual_check', name: 'home', update: true });
    expect(updated.content).toContain('Baseline "home" saved');
    const after = await run({ action: 'visual_check', name: 'home' });
    expect(after.isError).toBeFalsy();
    expect(after.content).toContain('No meaningful visual change');
  });

  it('captures an element or resizes the viewport first', async () => {
    const { run } = await setup(backend());
    const element = await run({ action: 'visual_check', name: 'button', ref: '@e1' });
    expect(element.content).toContain('First visual_check for "button"');
    expect(state.calls).toContain('screenshotElement @e1');

    await run({ action: 'visual_check', name: 'phone', width: 375 });
    expect(state.viewport).toEqual([375, 900]);
    await run({ action: 'visual_check', name: 'tablet', width: 800, height: 1200 });
    expect(state.viewport).toEqual([800, 1200]);

    const noElementBackend = backend();
    delete noElementBackend.screenshotElement;
    const { run: noElement } = await setup(noElementBackend);
    await closeSession(ctx.store.runId);
    const r = await noElement({ action: 'visual_check', name: 'button', ref: '@e1' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('cannot screenshot an element');
  });

  it('requires a stable name', async () => {
    const { run } = await setup(backend());
    const r = await run({ action: 'visual_check' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('needs "name"');
  });
});

describe('dev server actions', () => {
  it('starts a configured server, reports its status and stops it', async () => {
    const factory = devServers();
    const { run } = await setup(backend(), {}, factory);

    const started = await run({ action: 'start_server', command: 'npm run dev', port: 5173 });
    expect(started.content).toContain('Dev server running: `npm run dev` on http://localhost:5173');
    expect(started.content).toContain('VITE ready');
    expect(factory.starts).toEqual([{ command: 'npm run dev', port: 5173 }]);

    const status = await run({ action: 'server_status' });
    expect(status.content).toContain('Dev server running: `npm run dev` on http://localhost:5173');
    expect(status.content).toContain('Recent output:\nVITE ready');

    const stopped = await run({ action: 'stop_server' });
    expect(stopped.content).toBe('Dev server stopped.');
    expect(factory.stops).toBe(1);
    expect((await run({ action: 'server_status' })).content).toBe(
      'No dev server started by this session.',
    );
  });

  it('uses browser.serve and browser.serve_port defaults', async () => {
    const factory = devServers();
    const { run } = await setup(backend(), { serve: 'npm run dev', serve_port: 3000 }, factory);
    const r = await run({ action: 'start_server' });
    expect(r.content).toContain('on http://localhost:3000');
    expect(factory.starts).toEqual([{ command: 'npm run dev', port: 3000 }]);

    const status = await run({ action: 'server_status' });
    expect(status.content).toContain('`npm run dev` on http://localhost:3000');
  });

  it('starts the configured server when a local URL is opened', async () => {
    const factory = devServers();
    const { run } = await setup(backend(), { serve: 'npm run dev', serve_port: 3000 }, factory);
    await run({ action: 'open', url: 'http://localhost:3000/' });
    expect(factory.starts).toEqual([{ command: 'npm run dev', port: 3000 }]);

    // Opening another local URL does not spawn it again.
    await run({ action: 'open', url: 'http://localhost:3000/next' });
    expect(factory.starts).toHaveLength(1);
  });

  it('explains missing commands, bad ports, refusals and startup failures', async () => {
    const factory = devServers(true);
    const { run } = await setup(backend(), {}, factory);

    const missing = await run({ action: 'start_server' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('needs "command"');

    const badPort = await run({ action: 'start_server', command: 'npm run dev', port: 70_000 });
    expect(badPort.isError).toBe(true);
    expect(badPort.content).toContain('invalid port 70000');

    const denied = await run({ action: 'start_server', command: 'curl http://example.com' });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('refused by policy (network)');

    const failed = await run({ action: 'start_server', command: 'npm run dev', port: 3000 });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain('dev server failed to start: boom');

    const actions = (await events()).filter((e) => e.type === 'browser.action');
    expect(actions.some((e) => e.action === 'start_server' && e.running === false)).toBe(true);
  });

  it('can start a refused command after the user approves it', async () => {
    const factory = devServers();
    const root = await tempDir('browser-cockpit-');
    ctx = await toolContext(root, { ask: () => Promise.resolve(true) });
    const tool = createBrowserTool(
      { ...config },
      {
        createBackend: () => Promise.resolve(backend()),
        createDevServer: factory.create,
      },
    );
    const r = await tool.run(
      { action: 'start_server', command: 'curl http://example.com', port: 3000 },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(factory.starts).toEqual([{ command: 'curl http://example.com', port: 3000 }]);
  });

  it('reports no server before one is started', async () => {
    const { run } = await setup(backend());
    expect((await run({ action: 'server_status' })).content).toBe(
      'No dev server started by this session.',
    );
    expect((await run({ action: 'stop_server' })).content).toBe('Dev server stopped.');
  });
});
