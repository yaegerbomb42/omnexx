import { z } from 'zod';
import { listSkills, loadSkill } from '../../instructions/skills.js';
import { fail, ok, type Tool } from '../types.js';
import type { ToolSource } from './types.js';

const schema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe('Skill name, as listed in the system prompt with its description'),
});

/** On-demand loader for the skills listed in the prompt prefix (see docs/instructions.md). */
export const skillTool: Tool<typeof schema> = {
  name: 'skill',
  description:
    'Load a skill by name and get its full instructions. The system prompt lists every available skill (name + description); call this when the current task matches one. Returns the skill body.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    const roots = { repoRoot: ctx.jail.root, env: ctx.env };
    const skill = await loadSkill(input.name, roots);
    if (skill) return ok(skill.body);
    const available = await listSkills(roots);
    return fail(
      available.length > 0
        ? `no skill named "${input.name}"; available: ${available.map((s) => s.name).join(', ')}`
        : `no skill named "${input.name}" (no skills found in .omnexx/skills or the user config)`,
    );
  },
};

export const source: ToolSource = {
  load: () => [skillTool],
};
