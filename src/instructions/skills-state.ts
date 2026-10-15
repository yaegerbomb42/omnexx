import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../core/atomic.js';
import { resolvePaths } from '../core/paths.js';

/**
 * What the person chose about skills, kept in `<config home>/skills.json`: skills switched off,
 * marketplaces they added, and where each installed skill came from (so it can be updated).
 */

const installedSchema = z.object({
  /** Marketplace skill id: `owner/repo/path/to/skill`. */
  id: z.string(),
  /** Content hash (git tree sha) when installed; a different one upstream means an update. */
  sha: z.string(),
  installedAt: z.string(),
});

const stateSchema = z.object({
  disabled: z.array(z.string()).default([]),
  marketplaces: z.array(z.string()).default([]),
  installed: z.record(z.string(), installedSchema).default({}),
});

export type SkillsState = z.infer<typeof stateSchema>;
export type InstalledSkill = z.infer<typeof installedSchema>;

export const EMPTY_SKILLS_STATE: SkillsState = { disabled: [], marketplaces: [], installed: {} };

export const skillsStateFile = (env: NodeJS.ProcessEnv): string =>
  join(resolvePaths(env).configHome, 'skills.json');

export async function readSkillsState(env: NodeJS.ProcessEnv): Promise<SkillsState> {
  const raw = await readJson(skillsStateFile(env)).catch(() => undefined);
  const parsed = stateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : EMPTY_SKILLS_STATE;
}

/** Read, change (purely) and write back the state. */
export async function updateSkillsState(
  env: NodeJS.ProcessEnv,
  change: (s: SkillsState) => SkillsState,
): Promise<SkillsState> {
  const next = change(await readSkillsState(env));
  await writeJsonAtomic(skillsStateFile(env), next);
  return next;
}

export function setSkillEnabled(s: SkillsState, name: string, on: boolean): SkillsState {
  const rest = s.disabled.filter((n) => n !== name);
  return { ...s, disabled: on ? rest : [...rest, name].sort((a, b) => a.localeCompare(b)) };
}
