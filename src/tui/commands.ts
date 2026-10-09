import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../instructions/frontmatter.js';

export interface CustomCommand {
  name: string;
  description: string;
  /** The prompt; `$ARGUMENTS` is replaced by what follows the command. */
  template: string;
  /** Where it came from, for /help. */
  source: string;
}

/** Command folders, highest precedence first: the repo's, Claude Code's, then the person's own. */
export function commandDirs(repoRoot: string, configHome: string): string[] {
  return [
    join(repoRoot, '.omnexx', 'commands'),
    join(repoRoot, '.claude', 'commands'),
    join(configHome, 'commands'),
  ];
}

/**
 * Markdown files in the command folders become slash commands: `review.md` is `/review`. An
 * optional frontmatter `description:` shows in the menu; the first folder that has a name wins.
 */
export async function loadCustomCommands(dirs: readonly string[]): Promise<CustomCommand[]> {
  const out = new Map<string, CustomCommand>();
  for (const dir of dirs) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith('.md')).sort()) {
      const name = f.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || out.has(name)) continue;
      const { data, body } = parseFrontmatter(await readFile(join(dir, f), 'utf8'));
      const template = body.trim();
      if (!template) continue;
      const first = template.split('\n').find((l) => l.trim()) ?? '';
      out.set(name, {
        name,
        description: (data.description ?? first.replace(/^#+\s*/, '')).slice(0, 80),
        template,
        source: join(dir, f),
      });
    }
  }
  return [...out.values()];
}

/** Fill a command's template with what was typed after it. */
export function expandCommand(cmd: CustomCommand, args: string): string {
  return cmd.template.includes('$ARGUMENTS')
    ? cmd.template.replaceAll('$ARGUMENTS', args)
    : args
      ? `${cmd.template}\n\n${args}`
      : cmd.template;
}
