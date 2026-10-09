import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolvePaths } from '../../core/paths.js';
import { git } from '../../git/git.js';
import { listSkillsWithSource, skillDirs, type SkillRoots } from '../../instructions/skills.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

const SOURCE_LABEL = {
  'claude-user': 'Claude Code',
  config: '[skills] dirs',
  user: 'omnexx user',
  'claude-repo': 'repo .claude',
  repo: 'repo .omnexx',
} as const;

const isGitUrl = (s: string) => /^(https?|ssh|file):\/\/|^git@/.test(s) || s.endsWith('.git');

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Skill folders under `root`: root itself when it holds a SKILL.md, else each child (or `skills/*`) that does. */
export async function findSkillFolders(root: string): Promise<string[]> {
  if (await exists(join(root, 'SKILL.md'))) return [root];
  const out: string[] = [];
  for (const base of [root, join(root, 'skills')]) {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const e of entries)
      if (e.isDirectory() && (await exists(join(base, e.name, 'SKILL.md'))))
        out.push(join(base, e.name));
  }
  return out;
}

async function roots(io: CliIO): Promise<SkillRoots> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  return {
    repoRoot: io.cwd,
    env: io.env,
    dirs: config.skills.dirs,
    importClaude: config.skills.import_claude,
  };
}

export const register: CommandRegistrar = (program: Command, io: CliIO, setExit) => {
  const cmd = program.command('skills').description('List, add and import skills');
  const userDir = () => join(resolvePaths(io.env).configHome, 'skills');

  cmd
    .command('list')
    .description('every skill omnexx can use, and where it comes from')
    .action(async () => {
      const r = await roots(io);
      const skills = await listSkillsWithSource(r);
      if (!skills.length)
        println(io.stdout, 'No skills yet. Add one: omnexx skills add <path|git-url>');
      for (const s of skills)
        println(
          io.stdout,
          `${s.name.padEnd(28)} ${SOURCE_LABEL[s.source].padEnd(14)} ${s.description.replace(/\s+/g, ' ').slice(0, 80)}`,
        );
      println(
        io.stdout,
        `\nRead from: ${skillDirs(r)
          .map((d) => d.dir)
          .join(', ')}`,
      );
    });

  cmd
    .command('add <source>')
    .description(
      'copy a skill (a folder with SKILL.md, a folder of them, or a git repo) into your skills',
    )
    .option('--force', 'replace a skill of the same name')
    .action(async (source: string, opts: { force?: boolean }) => {
      let tmp: string | undefined;
      try {
        let root = resolve(io.cwd, source);
        if (isGitUrl(source)) {
          tmp = await mkdtemp(join(tmpdir(), 'omnexx-skill-'));
          await git(tmp, ['clone', '--depth', '1', '--', source, 'repo']);
          root = join(tmp, 'repo');
        }
        const folders = await findSkillFolders(root);
        if (!folders.length) {
          println(io.stderr, `No SKILL.md found in ${source} (or its subfolders or skills/).`);
          setExit(EXIT.error);
          return;
        }
        const added: string[] = [];
        for (const f of folders) {
          const dest = join(userDir(), basename(f));
          if ((await exists(dest)) && !opts.force) {
            println(io.stderr, `skip ${basename(f)}: already installed (--force to replace)`);
            continue;
          }
          await rm(dest, { recursive: true, force: true });
          await cp(f, dest, { recursive: true, filter: (p) => !p.split(sep).includes('.git') });
          added.push(basename(f));
        }
        if (added.length) println(io.stdout, `Added ${added.join(', ')} to ${userDir()}`);
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    });

  cmd
    .command('remove <name>')
    .description('remove a skill you added (other sources are left alone)')
    .action(async (name: string) => {
      const skill = (await listSkillsWithSource(await roots(io))).find((s) => s.name === name);
      if (!skill) {
        println(io.stderr, `No skill named "${name}".`);
        setExit(EXIT.error);
        return;
      }
      if (skill.source !== 'user') {
        println(io.stderr, `"${name}" comes from ${SOURCE_LABEL[skill.source]}; remove it there.`);
        setExit(EXIT.error);
        return;
      }
      await rm(join(skill.path, '..'), { recursive: true, force: true });
      println(io.stdout, `Removed ${name}.`);
    });

  cmd
    .command('import')
    .description("use Claude Code's skills (read in place, so they stay in sync)")
    .action(async () => {
      const r = await roots(io);
      if (!r.importClaude) {
        println(
          io.stdout,
          'Claude Code skills are off. Turn them on with [skills] import_claude = true.',
        );
        return;
      }
      const claude = (await listSkillsWithSource(r)).filter((s) => s.source.startsWith('claude'));
      println(
        io.stdout,
        claude.length
          ? `Using ${claude.length} Claude Code skill${claude.length === 1 ? '' : 's'}: ${claude.map((s) => s.name).join(', ')}`
          : 'No Claude Code skills found in ~/.claude/skills or .claude/skills.',
      );
    });
};
