import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { storeKey } from '../../../src/auth/keys.js';
import {
  runDoctorChecks,
  versionAtLeast,
  type DoctorDeps,
} from '../../../src/cli/commands/doctor.js';
import { defaultConfig } from '../../../src/config/load.js';
import type { ConfigInput } from '../../../src/config/schema.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { isTrustedJudgeHost } from '../../../src/judge/endpoint.js';
import { cli } from '../../support/cli.js';
import { secretCorpus } from '../../support/secrets.js';
import { isolatedEnv, tempRepo } from '../../support/tmp.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function mockOllama(version: string, models: string[]): Promise<string> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/version') res.end(JSON.stringify({ version }));
    else if (req.url === '/api/tags')
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    else res.writeHead(404).end('{}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function deps(env: NodeJS.ProcessEnv, config: ConfigInput = {}): DoctorDeps {
  return {
    env,
    paths: resolvePaths(env),
    config: defaultConfig(config),
    offline: true,
    nodeVersion: 'v24.1.0',
    versionOf: (b) => Promise.resolve(b === 'docker' ? undefined : `${b} 1.0`),
    fetch: globalThis.fetch,
    now: Date.now,
  };
}

describe('doctor never prints a key', () => {
  it('masks a key from env and from the credentials file, in text and --json', async () => {
    const key = secretCorpus().anthropic;
    for (const source of ['env', 'file'] as const) {
      const env = await isolatedEnv(source === 'env' ? { ANTHROPIC_API_KEY: key } : {});
      if (source === 'file') await storeKey(resolvePaths(env), 'anthropic', key);
      const cwd = await tempRepo();
      for (const args of [
        ['doctor', '--offline'],
        ['doctor', '--offline', '--json'],
      ]) {
        const r = await cli(args, { cwd, env });
        const all = r.stdout + r.stderr;
        expect(all).not.toContain(key);
        expect(all).not.toContain(key.slice(7, 30));
        expect(all).toContain(`present (sk-ant-…${key.slice(-4)})`);
      }
    }
  });

  it('fails with an actionable message when no key exists', async () => {
    const env = await isolatedEnv();
    const r = await cli(['doctor', '--offline'], { cwd: await tempRepo(), env });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/omnexx auth set anthropic/);
  });
});

describe('doctor checks', () => {
  it('flags old node, missing git, docker only when configured, enabled workers', async () => {
    const d = deps(await isolatedEnv(), {
      sandbox: 'docker',
      workers: { aider: { enabled: true } },
    });
    d.nodeVersion = 'v20.0.0';
    d.versionOf = () => Promise.resolve(undefined);
    const byName = Object.fromEntries((await runDoctorChecks(d)).map((c) => [c.name, c]));
    expect(byName.node?.status).toBe('fail');
    expect(byName.git?.status).toBe('fail');
    expect(byName.ripgrep?.status).toBe('warn');
    expect(byName.docker?.status).toBe('fail');
    expect(byName['worker aider']?.detail).toMatch(/not available until M3/);
    expect(byName['provider network']?.status).toBe('skip');
  });

  it('reports judge endpoint, version, model and latency against a mock Ollama', async () => {
    const url = await mockOllama('0.35.0', ['nimble:latest']);
    const d = deps(await isolatedEnv(), { judge: { kind: 'nimble', nimble: { url } } });
    d.offline = false;
    d.fetch = (input: string | URL | Request, init?: RequestInit) =>
      (input instanceof Request ? input.url : input.toString()).startsWith('http://127.0.0.1')
        ? fetch(input, init)
        : Promise.reject(new Error('no network in tests'));
    const byName = Object.fromEntries((await runDoctorChecks(d)).map((c) => [c.name, c]));
    expect(byName['judge endpoint']?.status).toBe('ok');
    expect(byName['judge reachability']?.detail).toMatch(/reachable, \d+ ms/);
    expect(byName['ollama version']?.status).toBe('ok');
    expect(byName['nimble model']?.status).toBe('ok');
    expect(byName['provider network']?.status).toBe('warn');
  });

  it('warns (not fails) on old Ollama, missing model and unreachable endpoints', async () => {
    const url = await mockOllama('0.34.9', ['llama3']);
    const d = deps(await isolatedEnv(), { judge: { kind: 'nimble', nimble: { url } } });
    d.offline = false;
    let byName = Object.fromEntries((await runDoctorChecks(d)).map((c) => [c.name, c]));
    expect(byName['ollama version']?.status).toBe('warn');
    expect(byName['nimble model']?.status).toBe('warn');

    const down = deps(await isolatedEnv(), {
      judge: { kind: 'nimble', nimble: { url: 'http://127.0.0.1:9', timeout_ms: 500 } },
    });
    down.offline = false;
    byName = Object.fromEntries((await runDoctorChecks(down)).map((c) => [c.name, c]));
    expect(byName['judge reachability']?.status).toBe('warn');
    expect(byName['judge reachability']?.detail).toMatch(/fails open/);

    const pub = deps(await isolatedEnv(), {
      judge: { kind: 'nimble', nimble: { url: 'http://192.168.1.5:11434' } },
    });
    byName = Object.fromEntries((await runDoctorChecks(pub)).map((c) => [c.name, c]));
    expect(byName['judge endpoint']?.status).toBe('warn');
    expect(byName['judge reachability']?.status).toBe('skip');
  });
});

describe('helpers', () => {
  it('versionAtLeast', () => {
    expect(versionAtLeast('0.35.0', [0, 35, 0])).toBe(true);
    expect(versionAtLeast('v0.36.1', [0, 35, 0])).toBe(true);
    expect(versionAtLeast('0.34.99', [0, 35, 0])).toBe(false);
    expect(versionAtLeast('garbage', [0, 35, 0])).toBe(false);
  });
  it('isTrustedJudgeHost', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      '100.64.0.1',
      '100.127.255.1',
      'mac.tail1234.ts.net',
    ]) {
      expect(isTrustedJudgeHost(h)).toBe(true);
    }
    for (const h of ['100.128.0.1', '10.0.0.2', '0.0.0.0', 'example.com', 'ts.net.evil.com']) {
      expect(isTrustedJudgeHost(h)).toBe(false);
    }
  });
});
