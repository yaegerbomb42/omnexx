import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { findSkillFolders, register } from '../../../src/cli/commands/skills.js';
import type { CliIO } from '../../../src/cli/io.js';
import { tempDir } from '../../support/tmp.js';

async function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  let out = '';
  let err = '';
  let code = 0;
  const io: CliIO = {
    stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    cwd,
    isTTY: false,
    env,
  };
  const program = new Command().exitOverride();
  register(program, io, (c) => (code = c));
  await program.parseAsync(['node', 'omnexx', ...args]);
  return { out, err, code };
}

async function skillFolder(root: string, name: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
  );
}

describe('omnexx skills', () => {
  async function setup() {
    const base = await tempDir('omnexx-skills-cli-');
    const env = {
      PATH: process.env.PATH,
      HOME: join(base, 'home'),
      OMNEXX_HOME: join(base, 'state'),
      OMNEXX_CONFIG_HOME: join(base, 'config'),
    };
    const repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    await skillFolder(join(base, 'home', '.claude', 'skills'), 'from-claude');
    return { base, env, repo };
  }

  it('adds one skill or a folder of them, lists them with their source, removes only its own', async () => {
    const { base, env, repo } = await setup();
    await skillFolder(join(base, 'pack', 'skills'), 'alpha');
    await skillFolder(join(base, 'pack', 'skills'), 'beta');
    await skillFolder(base, 'single');

    expect((await cli(['skills', 'add', join(base, 'pack')], repo, env)).out).toMatch(
      /Added alpha, beta/,
    );
    expect((await cli(['skills', 'add', join(base, 'single')], repo, env)).out).toMatch(
      /Added single/,
    );
    expect((await cli(['skills', 'add', join(base, 'single')], repo, env)).err).toMatch(
      /already installed/,
    );
    expect(await readdir(join(env.OMNEXX_CONFIG_HOME, 'skills'))).toEqual([
      'alpha',
      'beta',
      'single',
    ]);

    const list = (await cli(['skills', 'list'], repo, env)).out;
    expect(list).toMatch(/alpha\s+omnexx user/);
    expect(list).toMatch(/from-claude\s+Claude Code/);

    expect((await cli(['skills', 'remove', 'beta'], repo, env)).out).toMatch(/Removed beta/);
    const refused = await cli(['skills', 'remove', 'from-claude'], repo, env);
    expect(refused.err).toMatch(/comes from Claude Code/);
    expect(refused.code).toBe(1);
    expect((await cli(['skills', 'import'], repo, env)).out).toMatch(/Using 1 Claude Code skill/);
  });

  it('adds the skills in a git repository', async () => {
    const { base, env, repo } = await setup();
    const src = join(base, 'gitsrc');
    await skillFolder(join(src, 'skills'), 'from-git');
    const { git } = await import('../../../src/git/git.js');
    await git(src, ['init', '-q']);
    await git(src, ['add', '.']);
    await git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'skills']);
    const r = await cli(['skills', 'add', `file://${src}`], repo, env);
    expect(r.out).toMatch(/Added from-git/);
    expect(await readdir(join(env.OMNEXX_CONFIG_HOME, 'skills', 'from-git'))).toEqual(['SKILL.md']);
  });

  it('says so when a source has no SKILL.md', async () => {
    const { base, env, repo } = await setup();
    await mkdir(join(base, 'empty'));
    const r = await cli(['skills', 'add', join(base, 'empty')], repo, env);
    expect(r.err).toMatch(/No SKILL.md found/);
    expect(await findSkillFolders(join(base, 'empty'))).toEqual([]);
  });
});
