import { z } from 'zod';

/**
 * [skills]: where skills come from besides `.omnexx/skills` and the user config. Skills are
 * read in place, never copied, so edits made in another tool show up here too.
 */
export const skills = z
  .strictObject({
    /** More folders of skills (each skill is `<dir>/<name>/SKILL.md`); `~` is the home folder. */
    dirs: z.array(z.string().min(1)).default([]),
    /** Also use Claude Code's skills: `~/.claude/skills` and the repo's `.claude/skills`. */
    import_claude: z.boolean().default(true),
  })
  .prefault({});
