import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import {
  bootstrapEmptyProject,
  isEmptyProject,
  projectFolderFor,
  startTracking,
} from '../../../src/cli/bootstrap.js';
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

describe('startTracking', () => {
  it('turns a plain folder into a repo with a .gitignore and a first commit, once', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'notes.txt'), 'hello\n');
    await mkdir(join(dir, 'node_modules/x'), { recursive: true });
    await writeFile(join(dir, 'node_modules/x/i.js'), '1');
    expect(await startTracking(dir)).toBe(true);
    const files = (await git(dir, ['ls-files'])).stdout.split('\n');
    expect(files).toContain('notes.txt');
    expect(files).toContain('.gitignore');
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false);
    expect(await startTracking(dir)).toBe(false);
  });

  it('commits a repo that has no commit yet, keeping its own .gitignore', async () => {
    const dir = await tempDir();
    await git(dir, ['init', '-q']);
    await writeFile(join(dir, '.gitignore'), 'secret/\n');
    await writeFile(join(dir, 'a.md'), '# a\n');
    expect(await startTracking(dir)).toBe(true);
    expect((await git(dir, ['rev-parse', '--verify', 'HEAD'])).exitCode).toBe(0);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('secret/\n');
  });
});

describe('project folder for a too-broad cwd', () => {
  it('keeps a normal project folder as is', async () => {
    const home = await tempDir();
    const project = join(home, 'app');
    expect(await projectFolderFor(project, 'fix the bug', home)).toEqual({ dir: project, created: false });
  });

  it('makes a new folder under ~/omnexx-projects named after the goal when run from / or home', async () => {
    const home = await tempDir();
    const first = await projectFolderFor('/', 'Build a Snake game!', home);
    expect(first).toEqual({ dir: join(home, 'omnexx-projects', 'build-a-snake-game'), created: true });
    expect(await isEmptyProject(first.dir)).toBe(true);
    await writeFile(join(first.dir, 'x.txt'), 'x');
    const second = await projectFolderFor(home, 'build a snake game', home);
    expect(second.dir).toBe(join(home, 'omnexx-projects', 'build-a-snake-game-2'));
  });

  it('falls back to "project" when the goal has no letters', async () => {
    const home = await tempDir();
    const { dir } = await projectFolderFor('/', '???', home);
    expect(dir).toBe(join(home, 'omnexx-projects', 'project'));
  });
});
