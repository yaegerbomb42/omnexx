import { resolve } from 'node:path';
import type { Command } from 'commander';
import { addSkills, isGitUrl } from '../../integrations/install.js';
import { listSkillsWithSource, skillDirs } from '../../instructions/skills.js';
import { installedSkills, removeSkill, skillRoots, userSkillsDir } from '../chat-skills.js';
import { registerMarket } from './skills-market.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

export { findSkillFolders } from '../../integrations/install.js';

const roots = skillRoots;

export const register: CommandRegistrar = (program: Command, io: CliIO, setExit) => {
  const cmd = program.command('skills').description('List, add and import skills');
  const userDir = () => userSkillsDir(io.env);

  cmd
    .command('list')
    .description('every skill omnexx can use, and where it comes from')
    .action(async () => {
      const r = await roots(io);
      const skills = await installedSkills(io);
      if (!skills.length)
        println(
          io.stdout,
          'No skills yet. Find some: omnexx skills search <words>, or omnexx skills add <path|url>',
        );
      for (const s of skills)
        println(
          io.stdout,
          `${s.enabled ? 'on ' : 'off'} ${s.name.padEnd(28)} ${s.sourceLabel.padEnd(14)} ${String(s.tokens).padStart(4)} tok  ${s.description.replace(/\s+/g, ' ').slice(0, 70)}`,
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
      try {
        await removeSkill(io, name);
      } catch (err) {
        println(io.stderr, `${err instanceof Error ? err.message : String(err)}.`);
        setExit(EXIT.error);
        return;
      }
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
  registerMarket(cmd, io, setExit);
};
