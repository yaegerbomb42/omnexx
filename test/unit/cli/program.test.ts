import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyFile } from '../../../src/auth/keys.js';
import { VERSION } from '../../../src/cli/program.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { cli } from '../../support/cli.js';
import { secretCorpus } from '../../support/secrets.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('omnexx program', () => {
  it('--version and --help', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const v = await cli(['--version'], { cwd, env });
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toBe(VERSION);
    const h = await cli(['--help'], { cwd, env });
    expect(h.code).toBe(0);
    for (const cmd of ['init', 'doctor', 'auth']) expect(h.stdout).toContain(cmd);
  });

  it('unknown commands exit 1', async () => {
    const r = await cli(['frobnicate'], { cwd: await tempDir(), env: await isolatedEnv() });
    expect(r.code).toBe(1);
  });

  it('--help shows eight commands by default; --experimental shows the rest', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const h = await cli(['--help'], { cwd, env });
    expect(h.code).toBe(0);
    const shown = h.stdout.split('\n').filter((l) => /^ {2}[a-z]/.test(l));
    expect(shown).toHaveLength(8);
    for (const cmd of ['init', 'run', 'watch', 'status', 'logs', 'plan', 'doctor', 'auth']) {
      expect(h.stdout).toContain(cmd);
    }
    for (const cmd of ['pause', 'resume', 'stop', 'runs', 'connect', 'models', 'providers']) {
      expect(h.stdout).not.toMatch(new RegExp(`^  ${cmd}[ |\\[]`, 'm'));
    }
    const exp = await cli(['--experimental', '--help'], { cwd, env });
    expect(exp.stdout.split('\n').filter((l) => /^ {2}[a-z]/.test(l)).length).toBeGreaterThan(8);
    for (const cmd of ['pause', 'connect', 'models', 'providers']) {
      expect(exp.stdout).toContain(cmd);
    }
    // The env var and the config key open the same gate.
    const envExp = await cli(['--help'], { cwd, env: { ...env, OMNEXX_EXPERIMENTAL: '1' } });
    expect(envExp.stdout).toContain('pause');
    await mkdir(String(env.OMNEXX_CONFIG_HOME), { recursive: true });
    await writeFile(join(String(env.OMNEXX_CONFIG_HOME), 'config.toml'), 'experimental = true\n');
    const fileExp = await cli(['--help'], { cwd, env });
    expect(fileExp.stdout).toContain('pause');
  });

  it('run --help hides the mode and preset options unless experimental', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const h = await cli(['run', '--help'], { cwd, env });
    expect(h.code).toBe(0);
    for (const opt of ['--mode', '--plan ', '--kind', '--sandbox', '--for ']) {
      expect(h.stdout).not.toContain(opt);
    }
    for (const opt of ['--goal-file', '--budget', '--detach']) expect(h.stdout).toContain(opt);
    const exp = await cli(['--experimental', 'run', '--help'], { cwd, env });
    for (const opt of ['--mode', '--plan ', '--kind', '--sandbox'])
      expect(exp.stdout).toContain(opt);
  });

  it('auth set stores a 0600 file without echoing; clear removes it', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const key = secretCorpus().anthropic;
    const set = await cli(['auth', 'set', 'anthropic'], { cwd, env, stdin: `${key}\n` });
    expect(set.code).toBe(0);
    expect(set.stdout + set.stderr).not.toContain(key);
    const file = keyFile(resolvePaths(env), 'anthropic');
    expect((await readFile(file, 'utf8')).trim()).toBe(key);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await cli(['auth', 'clear', 'anthropic'], { cwd, env })).stdout).toContain('removed');
    expect((await cli(['auth', 'clear', 'anthropic'], { cwd, env })).stdout).toContain(
      'No stored key',
    );
    // W4: any lowercase provider name is accepted (keys stored per-provider at 0600).
    expect((await cli(['auth', 'set', 'openai'], { cwd, env, stdin: 'k\n' })).code).toBe(0);
    expect((await cli(['auth', 'set', 'BAD NAME!'], { cwd, env, stdin: 'k\n' })).stderr).toMatch(
      /unknown provider/,
    );
    expect((await cli(['auth', 'set', 'anthropic'], { cwd, env, stdin: '' })).stderr).toMatch(
      /no key entered/,
    );
  });
});
