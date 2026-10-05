import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { detectProject } from '../../../src/cli/detect.js';
import { cli } from '../../support/cli.js';
import { isolatedEnv, tempDir, tempRepo } from '../../support/tmp.js';

async function nodeRepo(pkg: object, files: Record<string, string> = {}) {
  const dir = await tempRepo();
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
  return dir;
}

describe('detectProject', () => {
  it('detects pnpm + typecheck/lint scripts + vitest', async () => {
    const dir = await nodeRepo(
      {
        scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest' },
        devDependencies: { vitest: '1' },
      },
      { 'pnpm-lock.yaml': '' },
    );
    const d = await detectProject(dir);
    expect(d.packageManager).toBe('pnpm');
    expect(d.setup).toEqual(['pnpm install --frozen-lockfile']);
    expect(d.gates.map((g) => [g.name, g.parser])).toEqual([
      ['typecheck', 'tsc'],
      ['lint', 'generic'],
      ['test', 'vitest'],
    ]);
  });

  it('detects node --test, jest, tsc-without-script, go, python and nothing', async () => {
    expect(
      (await detectProject(await nodeRepo({ scripts: { test: 'node --test' } }))).gates[0]?.parser,
    ).toBe('node-test');
    expect(
      (await detectProject(await nodeRepo({ devDependencies: { jest: '1' } }))).gates[0]?.parser,
    ).toBe('jest');
    const ts = await detectProject(
      await nodeRepo(
        { devDependencies: { typescript: '5' } },
        { 'tsconfig.json': '{}', 'package-lock.json': '{}' },
      ),
    );
    expect(ts.gates[0]?.run).toBe('npx --no-install tsc --noEmit');
    expect(ts.setup).toEqual(['npm ci']);
    const go = await tempDir();
    await writeFile(join(go, 'go.mod'), 'module x');
    expect((await detectProject(go)).gates.map((g) => g.parser)).toEqual(['generic', 'gotest']);
    const py = await tempDir();
    await writeFile(join(py, 'pyproject.toml'), '');
    expect((await detectProject(py)).gates[0]?.parser).toBe('pytest');
    expect((await detectProject(await tempDir())).language).toBe('unknown');
    expect(
      (
        await detectProject(
          await nodeRepo({ scripts: { test: 'echo "Error: no test specified"' } }),
        )
      ).gates,
    ).toEqual([]);
  });
});

describe('omnexx init', () => {
  it('asks before writing, writes a valid file, and is idempotent', async () => {
    const dir = await nodeRepo({ scripts: { test: 'node --test' } });
    const env = await isolatedEnv();

    const declined = await cli(['init'], { cwd: dir, env, stdin: 'n\n' });
    expect(declined.code).toBe(0);
    expect(declined.stdout).toContain('Nothing written.');
    await expect(readFile(join(dir, 'omnexx.toml'))).rejects.toThrow();

    const accepted = await cli(['init'], { cwd: dir, env, stdin: 'y\n' });
    expect(accepted.stdout).toContain('Wrote omnexx.toml');
    const first = await readFile(join(dir, 'omnexx.toml'), 'utf8');
    const { config } = await loadConfig({ cwd: dir, env });
    expect(config.gates[0]).toMatchObject({ name: 'test', parser: 'node-test' });

    const again = await cli(['init'], { cwd: dir, env });
    expect(again.stdout).toContain('already up to date');
    expect(await readFile(join(dir, 'omnexx.toml'), 'utf8')).toBe(first);
  });

  it('--yes writes without asking; never overwrites a hand-edited file', async () => {
    const dir = await nodeRepo({ scripts: { test: 'node --test' } });
    const env = await isolatedEnv();
    expect((await cli(['init', '--yes'], { cwd: dir, env })).stdout).toContain('Wrote');
    await writeFile(join(dir, 'omnexx.toml'), 'setup = []\n');
    const r = await cli(['init', '--yes'], { cwd: dir, env });
    expect(r.stdout).toContain('leaving it unchanged');
    expect(await readFile(join(dir, 'omnexx.toml'), 'utf8')).toBe('setup = []\n');
  });

  it('refuses outside a git repo', async () => {
    const r = await cli(['init', '--yes'], { cwd: await tempDir(), env: await isolatedEnv() });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error\[usage\]: .* is not a git repository/);
  });
});
