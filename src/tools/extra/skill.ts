import { z } from 'zod';
import type { OmnexxConfig } from '../../config/schema.js';
import { listSkills, loadSkill, type SkillRoots } from '../../instructions/skills.js';
import { readSkillsState } from '../../instructions/skills-state.js';
import { fail, ok, type Tool } from '../types.js';
import type { ToolSource } from './types.js';

const schema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe('Skill name, as listed in this tool’s description; "list" shows every skill in full'),
});

/**
 * The skill list rides along with every request, so it stays short: a name and the start of its
 * description each, within this budget. `name: "list"` returns the full descriptions on demand.
 */
const LIST_MAX_CHARS = 1_500;
const GIST_CHARS = 70;

/** The start of a description, cut at a word boundary. */
export function gist(text: string, max = GIST_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,.;:]$/, '')}…`;
}

/** One line per skill for the tool description, cut to a budget so the prefix stays small. */
export function skillCatalog(skills: readonly { name: string; description: string }[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const s of skills) {
    const line = `- ${s.name}: ${gist(s.description)}`;
    if (size + line.length > LIST_MAX_CHARS) {
      lines.push(
        `- … ${skills.length - lines.length} more (call with name "list" to see them all)`,
      );
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

/** On-demand loader for skills (see docs/instructions.md); the description lists what exists. */
export function skillTool(config: Pick<OmnexxConfig, 'skills'>, catalog = ''): Tool<typeof schema> {
  const rootsFor = async (repoRoot: string, env: NodeJS.ProcessEnv): Promise<SkillRoots> => ({
    repoRoot,
    env,
    dirs: config.skills.dirs,
    importClaude: config.skills.import_claude,
    disabled: (await readSkillsState(env)).disabled,
  });
  return {
    name: 'skill',
    description: `Load a skill by name and get its full instructions. Call this when the current task matches one.${catalog ? `\nAvailable skills:\n${catalog}` : ''}`,
    schema,
    readOnly: true,
    async run(input, ctx) {
      const roots = await rootsFor(ctx.jail.root, ctx.env);
      if (input.name === 'list') {
        const all = await listSkills(roots);
        return ok(
          all.length
            ? all.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`).join('\n')
            : 'no skills found (see omnexx skills list)',
        );
      }
      const skill = await loadSkill(input.name, roots);
      if (skill) return ok(skill.body);
      const available = await listSkills(roots);
      return fail(
        available.length > 0
          ? `no skill named "${input.name}"; available: ${available.map((s) => s.name).join(', ')}`
          : `no skill named "${input.name}" (no skills found; see omnexx skills list)`,
      );
    },
  };
}

export const source: ToolSource = {
  // Built per cycle from the run's (or chat's) own repo and environment, so the catalog reflects
  // skills added since and an isolated run never sees the host's skills.
  load: async (config, where) => {
    const skills = await listSkills({
      repoRoot: where?.repoRoot ?? process.cwd(),
      env: where?.env ?? process.env,
      dirs: config.skills.dirs,
      importClaude: config.skills.import_claude,
      disabled: (await readSkillsState(where?.env ?? process.env)).disabled,
    });
    // No skills: the tool could only fail, so its schema stays out of the prefix.
    return skills.length ? [skillTool(config, skillCatalog(skills))] : [];
  },
};
