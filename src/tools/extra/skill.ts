import { z } from 'zod';
import type { OmnexxConfig } from '../../config/schema.js';
import { listSkills, loadSkill, type SkillRoots } from '../../instructions/skills.js';
import { fail, ok, type Tool } from '../types.js';
import type { ToolSource } from './types.js';

const schema = z.strictObject({
  name: z.string().min(1).describe('Skill name, as listed in this tool’s description'),
});

/** The list of skills in the tool description stays well under this. */
const LIST_MAX_CHARS = 6_000;

/** One line per skill for the tool description, cut to a budget so the prefix stays small. */
export function skillCatalog(skills: readonly { name: string; description: string }[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const s of skills) {
    const line = `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 200)}`;
    if (size + line.length > LIST_MAX_CHARS) {
      lines.push(`- … ${skills.length - lines.length} more (call with a name to load one)`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

/** On-demand loader for skills (see docs/instructions.md); the description lists what exists. */
export function skillTool(config: Pick<OmnexxConfig, 'skills'>, catalog = ''): Tool<typeof schema> {
  const rootsFor = (repoRoot: string, env: NodeJS.ProcessEnv): SkillRoots => ({
    repoRoot,
    env,
    dirs: config.skills.dirs,
    importClaude: config.skills.import_claude,
  });
  return {
    name: 'skill',
    description: `Load a skill by name and get its full instructions. Call this when the current task matches one.${catalog ? `\nAvailable skills:\n${catalog}` : ''}`,
    schema,
    readOnly: true,
    async run(input, ctx) {
      const roots = rootsFor(ctx.jail.root, ctx.env);
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
    });
    return [skillTool(config, skillCatalog(skills))];
  },
};
