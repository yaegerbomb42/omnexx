import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolvePaths } from '../../core/paths.js';
import { addSkills, isGitUrl } from '../../integrations/install.js';
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

export { findSkillFolders } from '../../integrations/install.js';

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
      const r = await addSkills(
        isGitUrl(source) ? source : resolve(io.cwd, source),
        userDir(),
        opts.force,
      );
      if (!r.found) {
        println(io.stderr, `No SKILL.md found in ${source} (or its subfolders or skills/).`);
        setExit(EXIT.error);
        return;
      }
      for (const name of r.skipped)
        println(io.stderr, `skip ${name}: already installed (--force to replace)`);
      if (r.added.length) println(io.stdout, `Added ${r.added.join(', ')} to ${userDir()}`);
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
