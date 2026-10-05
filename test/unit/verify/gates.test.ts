import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { runShell } from '../../../src/core/exec.js';
import { scrubEnv } from '../../../src/security/env-scrub.js';
import { runGates, toBaseline } from '../../../src/verify/gates.js';
import { secretCorpus } from '../../support/secrets.js';
import { tempDir } from '../../support/tmp.js';

const env = scrubEnv(process.env);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runShell', () => {
  it('captures interleaved output and exit code, writes a redacted log', async () => {
    const dir = await tempDir();
    const secret = secretCorpus().github;
    const r = await runShell(`echo out; echo err 1>&2; echo ${secret}; exit 3`, {
      cwd: dir,
      env,
      timeoutMs: 10_000,
      logPath: join(dir, 'log'),
      redact: (s) => s.replace(secret, '[R]'),
    });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(await readFile(join(dir, 'log'), 'utf8')).not.toContain(secret);
  });

  it('timeout kills the whole process tree, leaving no orphans', async () => {
    const dir = await tempDir();
    const r = await runShell('sleep 30 & echo $! > child.pid; sleep 30', {
      cwd: dir,
      env,
      timeoutMs: 300,
      killGraceMs: 100,
    });
    expect(r.timedOut).toBe(true);
    const childPid = Number((await readFile(join(dir, 'child.pid'), 'utf8')).trim());
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(childPid)).toBe(false);
  });

  it('abort signal stops the command', async () => {
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 100);
    const r = await runShell('sleep 30', {
      cwd: await tempDir(),
      env,
      timeoutMs: 10_000,
      signal: ac.signal,
      killGraceMs: 50,
    });
    expect(r.aborted).toBe(true);
  });

  it('feeds stdin', async () => {
    const r = await runShell('cat', {
      cwd: await tempDir(),
      env,
      timeoutMs: 5_000,
      stdin: 'hello',
    });
    expect(r.output).toBe('hello');
  });
});

describe('runGates', () => {
  it('runs gates in order, honours max_cmd_timeout, parses, and builds a baseline', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'ok.mjs'),
      "import {test} from 'node:test'; test('a', () => {}); test('b', () => { throw new Error('nope'); });\n",
    );
    const cfg = defaultConfig({
      gates: [
        { name: 'test', run: 'node --test --test-reporter=tap ok.mjs', parser: 'node-test' },
        { name: 'slow', run: 'sleep 20', timeout: '1h' },
      ],
    });
    const results = await runGates(cfg.gates, {
      cwd: dir,
      env,
      logsDir: dir,
      label: 'baseline',
      maxCmdTimeoutMs: 500,
      redact: (s) => s,
    });
    expect(results[0]).toMatchObject({ name: 'test', exitCode: 1, structured: true });
    expect(results[0]?.failures.map((f) => f.id)).toEqual(['ok.mjs > b']);
    expect(results[1]?.timedOut).toBe(true);
    expect(toBaseline(results).test?.failureIds).toEqual(['ok.mjs > b']);
    expect(await readFile(join(dir, 'gate-baseline-test.log'), 'utf8')).toContain('TAP version');
  });
});
