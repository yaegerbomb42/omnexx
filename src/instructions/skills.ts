import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
  /** Extra skill folders from `[skills] dirs`; `~` expands to the home folder. */
  dirs?: readonly string[];
  /** Also read Claude Code's skills (`~/.claude/skills`, repo `.claude/skills`). */
  importClaude?: boolean;
}

/** One folder skills are read from, in precedence order (later wins), with where it came from. */
export interface SkillDir {
  dir: string;
  source: 'claude-user' | 'config' | 'user' | 'claude-repo' | 'repo';
}

function expandHome(p: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/**
 * Every folder skills come from, lowest precedence first: Claude Code's user skills, extra
 * `[skills] dirs`, omnexx user skills, then the repo's (Claude's, then omnexx's). A skill in a
 * later folder shadows one of the same name in an earlier folder.
 */
export function skillDirs(roots: SkillRoots): SkillDir[] {
  const env = roots.env ?? process.env;
  const out: SkillDir[] = [];
  if (roots.importClaude)
    out.push({ dir: expandHome('~/.claude/skills', env), source: 'claude-user' });
  for (const d of roots.dirs ?? []) {
    const dir = expandHome(d, env);
    out.push({
      dir: isAbsolute(dir) || !roots.repoRoot ? dir : join(roots.repoRoot, dir),
      source: 'config',
    });
  }
  out.push({ dir: join(resolvePaths(env).configHome, 'skills'), source: 'user' });
  if (roots.repoRoot !== undefined) {
    if (roots.importClaude)
      out.push({ dir: join(roots.repoRoot, '.claude', 'skills'), source: 'claude-repo' });
    out.push({ dir: join(roots.repoRoot, '.omnexx', 'skills'), source: 'repo' });
  }
  return out;
}

async function readSkillDir(dir: string): Promise<Map<string, Skill>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // Symlinked skill folders count too: people link skills between tools (~/.agents/skills).
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
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

/** Every skill by name; folders later in `skillDirs` shadow earlier ones. */
async function skillMap(
  roots: SkillRoots,
): Promise<Map<string, Skill & { source: SkillDir['source'] }>> {
  const out = new Map<string, Skill & { source: SkillDir['source'] }>();
  for (const { dir, source } of skillDirs(roots))
    for (const [name, skill] of await readSkillDir(dir)) out.set(name, { ...skill, source });
  return out;
}

/** Every skill with the file it comes from, sorted by name: for `omnexx skills list`. */
export async function listSkillsWithSource(
  roots: SkillRoots = {},
): Promise<(SkillSummary & { path: string; source: SkillDir['source'] })[]> {
  return [...(await skillMap(roots)).values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, description, path, source }) => ({ name, description, path, source }));
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
