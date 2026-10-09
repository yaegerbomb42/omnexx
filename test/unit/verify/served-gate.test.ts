import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateSchema } from '../../../src/config/schema.js';
import type { BrowserBackend } from '../../../src/tools/extra/browser/types.js';
import { runGate, type GateRunContext } from '../../../src/verify/gates.js';
import { tempDir } from '../../support/tmp.js';

/** A browser that fetches the page itself and "renders" its text, logging nothing. */
function fetchingBrowser(opened: string[], errors: string[] = []): BrowserBackend {
  let body = '';
  return {
    name: 'fetching',
    open: async (url) => {
      opened.push(url);
      body = await (await fetch(url)).text();
    },
    snapshot: () => Promise.resolve(body.replace(/<[^>]+>/g, ' ').trim()),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    press: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    screenshot: () => Promise.resolve({ base64: '', mimeType: 'image/png' }),
    console: () => Promise.resolve(errors.map((text) => ({ type: 'error', text }))),
    close: () => Promise.resolve(),
  };
}

const SERVER = `import { createServer } from 'node:http';
createServer((_, res) => res.end(process.env.BODY)).listen(Number(process.env.PORT));`;

async function setup(body: string, scripts: Record<string, string> = { start: 'node server.mjs' }) {
  const dir = await tempDir();
  await writeFile(join(dir, 'server.mjs'), SERVER);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts }));
  const ctx: GateRunContext = {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', BODY: body },
    logsDir: dir,
    label: 'c1',
    maxCmdTimeoutMs: 20_000,
    redact: (s) => s,
  };
  return ctx;
}

const gate = gateSchema.parse({
  name: 'page',
  run: 'node server.mjs',
  kind: 'browser',
  requires_script: 'start',
  timeout: '20s',
});

describe('browser gates that serve the app', () => {
  it('starts the app on $PORT, checks it, and stops it', async () => {
    const opened: string[] = [];
    const ctx = await setup('<h1>Monkeys</h1><p>Bananas, trees, and very good climbing.</p>');
    const r = await runGate(gate, { ...ctx, browser: fetchingBrowser(opened) });
    expect(r.failures).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(opened[0]).toMatch(/^http:\/\/localhost:\d+$/);
    await expect(fetch(opened[0] ?? '')).rejects.toThrow();
  });

  it('fails a blank page and console errors', async () => {
    const blank = await runGate(gate, {
      ...(await setup('<div></div>')),
      browser: fetchingBrowser([]),
    });
    expect(blank.failures[0]?.message).toMatch(/looks empty/);
    const noisy = await runGate(gate, {
      ...(await setup('<h1>Monkeys</h1><p>Bananas, trees, and very good climbing.</p>')),
      browser: fetchingBrowser([], ['TypeError: x is undefined']),
    });
    expect(noisy.failures[0]?.message).toMatch(/console errors/);
  });

  it('fails when the server dies, and skips while there is no start script', async () => {
    const dead = await runGate(
      { ...gate, run: 'echo boom; exit 3' },
      { ...(await setup('')), browser: fetchingBrowser([]) },
    );
    expect(dead.failures[0]?.id).toBe('page:serve');
    const skipped = await runGate(gate, { ...(await setup('', {})), browser: fetchingBrowser([]) });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.tests?.total).toBe(0);
  });
});
