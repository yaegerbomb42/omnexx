import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevServer, freePort, portOpen } from '../../../src/browser/dev-server.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { bindRun, readChildren, unbindRun } from '../../../src/core/process-registry.js';

const node = JSON.stringify(process.execPath);
const running = new Set<DevServer>();

function server(opts: ConstructorParameters<typeof DevServer>[0]): DevServer {
  const s = new DevServer(opts);
  running.add(s);
  return s;
}

afterEach(async () => {
  await Promise.all([...running].map((s) => s.stop()));
  running.clear();
});

describe('dev server supervisor', () => {
  it('reserves a free port until the consumer releases it', async () => {
    const { port, release } = await freePort();
    expect(port).toBeGreaterThan(0);
    // Still listening at resolve time: the port was never given up before the
    // consumer learned about it.
    expect(await portOpen(port)).toBe(true);
    await release();
    expect(await portOpen(port)).toBe(false);

    // Re-binding right after release succeeds without conflict.
    const http = createServer();
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    await new Promise<void>((resolve) =>
      http.close(() => {
        resolve();
      }),
    );
  });

  it('starts a server, exposes its status and output, and stops its process group', async () => {
    const { port, release } = await freePort();
    await release();
    const s = server({
      command: `${node} -e "console.log('ready soon'); require('node:http').createServer((q,r)=>r.end('ok')).listen(${String(port)})"`,
      cwd: process.cwd(),
      port,
      timeoutMs: 10_000,
    });
    const started = await s.start();
    expect(started.running).toBe(true);
    expect(started.port).toBe(port);
    expect(started.startedAt).toBeTypeOf('number');
    expect(started.output).toContain('ready soon');
    expect(await portOpen(port)).toBe(true);

    // A second start is a no-op, not a second process.
    const again = await s.start();
    expect(again.startedAt).toBe(started.startedAt);

    await s.stop();
    expect(s.status().running).toBe(false);
    expect(await portOpen(port)).toBe(false);
  }, 20_000);

  it('waits for a URL to answer, including error statuses', async () => {
    const http = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const port = (http.address() as AddressInfo).port;
    try {
      const s = server({
        command: `${node} -e "setTimeout(()=>{},10000)"`,
        cwd: process.cwd(),
        url: `http://127.0.0.1:${String(port)}/health`,
        timeoutMs: 5_000,
      });
      const status = await s.start();
      expect(status.running).toBe(true);
      expect(status.url).toBe(`http://127.0.0.1:${String(port)}/health`);
    } finally {
      http.close();
      await once(http, 'close');
    }
  }, 15_000);

  it('explains a server that exits before it is ready', async () => {
    const { port, release } = await freePort();
    await release();
    const s = server({
      command: `${node} -e "console.error('missing config'); process.exit(3)"`,
      cwd: process.cwd(),
      port,
      timeoutMs: 5_000,
    });
    await expect(s.start()).rejects.toThrow(/exited with code 3[\s\S]*missing config/);
    expect(s.status().running).toBe(false);
  }, 15_000);

  it('times out and cleans up a server that never answers', async () => {
    const { port, release } = await freePort();
    await release();
    const s = server({
      command: `${node} -e "setTimeout(()=>{},5000)"`,
      cwd: process.cwd(),
      port,
      timeoutMs: 400,
    });
    await expect(s.start()).rejects.toThrow(/did not answer on port/);
    expect(s.status().running).toBe(false);
    expect(await portOpen(port)).toBe(false);
  }, 15_000);

  it('supports a command with no health check', async () => {
    const s = server({
      command: `${node} -e "console.log('started'); setTimeout(()=>{},5000)"`,
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    const status = await s.start();
    expect(status.running).toBe(true);
    expect(status.port).toBeUndefined();
    expect(status.url).toBeUndefined();
    expect(status.output).toContain('started');
  }, 10_000);

  it('autoPort picks a free high port, hands it over via PORT, and the server answers on it', async () => {
    const s = server({
      command: `${node} -e "require('node:http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT||0),'127.0.0.1')"`,
      cwd: process.cwd(),
      autoPort: true,
      timeoutMs: 10_000,
    });
    const started = await s.start();
    expect(started.running).toBe(true);
    expect(started.port).toBeDefined();
    expect(started.port).toBeGreaterThanOrEqual(10_000);
    expect(started.port).not.toBe(3000);
    expect(started.port).not.toBe(5173);
    expect(started.port).not.toBe(8080);
    expect(await portOpen(started.port ?? 0)).toBe(true);
    await s.stop();
    expect(await portOpen(started.port ?? 0)).toBe(false);
  }, 20_000);

  it('registers the server in the run registry while it runs, and unregisters on stop', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-registry-'));
    try {
      const paths = resolvePaths({ OMNEXX_HOME: home });
      bindRun(paths, 'r_test');
      const { port, release } = await freePort();
      await release();
      const s = server({
        command: `${node} -e "require('node:http').createServer((q,r)=>r.end('ok')).listen(${String(port)},'127.0.0.1')"`,
        cwd: process.cwd(),
        port,
        runId: 'r_test',
        timeoutMs: 5_000,
      });
      const started = await s.start();
      expect(started.running).toBe(true);
      const children = readChildren(paths, 'r_test');
      expect(children).toHaveLength(1);
      expect(children[0]?.kind).toBe('server');
      expect(typeof children[0]?.pid).toBe('number');
      await s.stop();
      expect(readChildren(paths, 'r_test')).toEqual([]);
    } finally {
      unbindRun();
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a command that dies without a health check', async () => {
    const s = server({
      command: `${node} -e "process.exit(2)"`,
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    await expect(s.start()).rejects.toThrow(/exited with code 2/);
  }, 10_000);
});
