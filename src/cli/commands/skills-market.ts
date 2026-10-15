import type { Command } from 'commander';
import { describeError } from '../../errors.js';
import type { MarketSkill } from '../../integrations/skills-github.js';
import {
  addMarketplace,
  catalog,
  filterSkills,
  marketplaces,
  previewMarketSkill,
  removeMarketplace,
  updateMarketSkills,
  type MarketDeps,
} from '../../integrations/skills-market.js';
import { installSkill, marketDeps, setEnabled, userSkillsDir } from '../chat-skills.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';

/**
 * `omnexx skills search|info|install|update|enable|disable|market`: skill marketplaces (GitHub
 * repos of SKILL.md folders) and switching skills on and off. `/skills …` in the terminal UI
 * runs these too.
 */

const SEARCH_LIMIT = 40;

function fileList(s: MarketSkill): string {
  return s.files.map((f) => `  ${f.path} (${String(f.size)} B)`).join('\n');
}

export function registerMarket(
  cmd: Command,
  io: CliIO,
  setExit: (code: number) => void,
  deps: MarketDeps = marketDeps(io),
): void {
  /** Run an action, turning a thrown error into a message and a failing exit code. */
  const guard =
    <A extends unknown[]>(fn: (...a: A) => Promise<void>) =>
    async (...a: A): Promise<void> => {
      try {
        await fn(...a);
      } catch (err) {
        println(io.stderr, describeError(err));
        setExit(EXIT.error);
      }
    };

  cmd
    .command('search [words...]')
    .description('search the skill marketplaces (all skills when no words are given)')
    .option('--refresh', 'read the marketplaces again instead of the day-old cache')
    .action(
      guard(async (words: string[], opts: { refresh?: boolean }) => {
        const { skills, errors } = await catalog(deps, opts.refresh);
        const found = filterSkills(skills, words.join(' '));
        for (const e of errors) println(io.stderr, `could not read ${e}`);
        if (!found.length) println(io.stdout, 'No marketplace skills match.');
        for (const s of found.slice(0, SEARCH_LIMIT))
          println(
            io.stdout,
            `${s.id.padEnd(48)} ${s.description.replace(/\s+/g, ' ').slice(0, 70)}`,
          );
        if (found.length > SEARCH_LIMIT)
          println(io.stdout, `… ${String(found.length - SEARCH_LIMIT)} more; narrow the search`);
        if (found.length) println(io.stdout, '\nRead one: omnexx skills info <id>');
      }),
    );

  cmd
    .command('info <id>')
    .description("a marketplace skill's source, files and SKILL.md, before installing it")
    .action(
      guard(async (id: string) => {
        const { skill, text } = await previewMarketSkill(id, deps);
        println(io.stdout, `${skill.name}  from ${skill.url}\nFiles:\n${fileList(skill)}\n`);
        println(io.stdout, text);
      }),
    );

  cmd
    .command('install <id>')
    .description('copy a marketplace skill into your skills and turn it on (nothing is run)')
    .option('--force', 'replace a skill of the same name')
    .action(
      guard(async (id: string, opts: { force?: boolean }) => {
        const { name, skill } = await installSkill(io, id, deps, opts.force);
        println(
          io.stdout,
          `Installed ${name} from ${skill.url}\nFiles:\n${fileList(skill)}\nScripts in it are never run automatically.`,
        );
      }),
    );

  cmd
    .command('update [name]')
    .description('re-install marketplace skills that changed upstream')
    .action(
      guard(async (name?: string) => {
        const r = await updateMarketSkills(userSkillsDir(io.env), deps, name);
        println(
          io.stdout,
          r.updated.length ? `Updated ${r.updated.join(', ')}.` : 'All up to date.',
        );
        for (const m of r.missing) println(io.stderr, `${m}: no longer in its marketplace`);
      }),
    );

  for (const [verb, on] of [
    ['enable', true],
    ['disable', false],
  ] as const)
    cmd
      .command(`${verb} <name>`)
      .description(on ? 'turn a skill back on' : 'turn a skill off (it stays installed)')
      .action(
        guard(async (name: string) => {
          await setEnabled(io, name, on);
          println(io.stdout, `${name} is ${on ? 'on' : 'off'}.`);
        }),
      );

  cmd
    .command('market [action] [source]')
    .description('marketplaces: list (default), add <owner/repo|url>, remove <owner/repo>')
    .action(
      guard(async (action = 'list', source?: string) => {
        if (action === 'list') {
          for (const m of await marketplaces(io.env)) println(io.stdout, m);
          return;
        }
        if (!source) throw new Error(`usage: omnexx skills market ${action} <owner/repo>`);
        if (action === 'add')
          println(io.stdout, `Added marketplace ${await addMarketplace(source, deps)}.`);
        else if (action === 'remove') {
          await removeMarketplace(source, io.env);
          println(io.stdout, `Removed marketplace ${source}.`);
        } else throw new Error('usage: omnexx skills market [list|add|remove] [owner/repo]');
      }),
    );
}
