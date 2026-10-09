import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { bootstrapEmptyProject, isEmptyProject } from '../../../src/cli/bootstrap.js';
import { git } from '../../../src/git/git.js';
import { isolatedEnv, tempDir, tempRepo } from '../../support/tmp.js';

describe('empty-folder bootstrap', () => {
  it('only treats folders with no files and no commits as empty', async () => {
    const plain = await tempDir();
    expect(await isEmptyProject(plain)).toBe(true);
    await writeFile(join(plain, '.DS_Store'), '');
    expect(await isEmptyProject(plain)).toBe(true);
    await writeFile(join(plain, 'notes.txt'), 'hi');
    expect(await isEmptyProject(plain)).toBe(false);

    const repo = await tempRepo();
    expect(await isEmptyProject(repo)).toBe(true);
    await writeFile(join(repo, '.gitignore'), 'x\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    expect(await isEmptyProject(repo)).toBe(false);
  });

  it('inits git, writes starter gates and commits once', async () => {
    const dir = await tempDir('Monkey Site ');
    const files = await bootstrapEmptyProject(dir, { browser: false });
    expect(files).toEqual(['package.json', 'omnexx.toml', 'AGENTS.md', '.gitignore']);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toMatch(/^monkey-site-/);
    expect(pkg.scripts.test).toBe('node --test');
    const { config } = await loadConfig({ cwd: dir, env: await isolatedEnv() });
    expect(config.gates.map((g) => g.name)).toEqual(['build', 'lint', 'typecheck', 'test']);
    const log = await git(dir, ['log', '--oneline']);
    expect(log.stdout.split('\n')).toHaveLength(1);
    expect(await isEmptyProject(dir)).toBe(false);
  });

  it('adds a browser page gate when a browser is installed', async () => {
    const dir = await tempDir();
    await bootstrapEmptyProject(dir, { browser: true });
    const { config } = await loadConfig({ cwd: dir, env: await isolatedEnv() });
    expect(config.gates.at(-1)).toMatchObject({
      name: 'page',
      kind: 'browser',
      run: 'npm start',
      requires_script: 'start',
    });
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('$PORT');
  });
});
