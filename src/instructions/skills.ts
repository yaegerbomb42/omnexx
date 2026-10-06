import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePaths } from '../core/paths.js';
import { CHARS_PER_TOKEN, estimateTokens } from '../core/tokens.js';
import { parseFrontmatter } from './frontmatter.js';
import { readTextIfExists } from './read.js';

/** Body budget per skill, in estimated tokens. */
export const SKILL_MAX_TOKENS = 6_000;

const TRUNCATE_MARKER = '… (truncated)';

export interface SkillSummary {
  name: string;
  description: string;
}

export interface Skill extends SkillSummary {
  /** Absolute path of the SKILL.md that provided this skill. */
  path: string;
  /** Frontmatter stripped; capped at SKILL_MAX_TOKENS when loaded. */
  body: string;
  truncated: boolean;
}

export interface SkillRoots {
  /** The repository whose `.omnexx/skills` to scan; user skills are always scanned. */
  repoRoot?: string;
  /** Environment for `OMNEXX_CONFIG_HOME` / `XDG_CONFIG_HOME` resolution. */
  env?: NodeJS.ProcessEnv;
}

async function readSkillDir(dir: string): Promise<Map<string, Skill>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out = new Map<string, Skill>();
  for (const dirName of dirs) {
    const path = join(dir, dirName, 'SKILL.md');
    const text = await readTextIfExists(path);
    if (!text?.trim()) continue;
    const { data, body } = parseFrontmatter(text);
    const frontName = data.name?.trim() ?? '';
    const name = frontName.length > 0 ? frontName : dirName;
    if (out.has(name)) continue;
    out.set(name, {
      name,
      description: data.description?.trim() ?? '',
      path,
      body,
      truncated: false,
    });
  }
  return out;
}

/** User skills first, then repo skills on top: a repo skill shadows a user skill of the same name. */
async function skillMap(roots: SkillRoots): Promise<Map<string, Skill>> {
  const configHome = resolvePaths(roots.env ?? process.env).configHome;
  const out = await readSkillDir(join(configHome, 'skills'));
  if (roots.repoRoot !== undefined) {
    const repo = await readSkillDir(join(roots.repoRoot, '.omnexx', 'skills'));
    for (const [name, skill] of repo) out.set(name, skill);
  }
  return out;
}

/**
 * Name and description of every discoverable skill, sorted by name (byte-stable). This is what
 * goes in the prompt prefix; the `skill` tool loads a body on demand.
 */
export async function listSkills(roots: SkillRoots = {}): Promise<SkillSummary[]> {
  const all = await skillMap(roots);
  return [...all.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, description }) => ({ name, description }));
}

/** One skill by name with its body (≤ SKILL_MAX_TOKENS), or undefined when it does not exist. */
export async function loadSkill(name: string, roots: SkillRoots = {}): Promise<Skill | undefined> {
  const skill = (await skillMap(roots)).get(name);
  if (!skill) return undefined;
  const budget = SKILL_MAX_TOKENS * CHARS_PER_TOKEN;
  if (estimateTokens(skill.body) <= SKILL_MAX_TOKENS) return skill;
  return {
    ...skill,
    body: `${skill.body.slice(0, Math.max(0, budget - TRUNCATE_MARKER.length - 1))}\n${TRUNCATE_MARKER}`,
    truncated: true,
  };
}
