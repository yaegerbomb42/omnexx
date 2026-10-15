import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../core/atomic.js';
import { resolvePaths } from '../core/paths.js';
import { readSkillsState, updateSkillsState } from '../instructions/skills-state.js';
import {
  fetchRaw,
  fetchRawBytes,
  listRepoSkills,
  marketplaceRepos,
  MAX_FILE_BYTES,
  parseRepoRef,
  repoName,
  safeRelativePath,
  type FetchLike,
  type MarketSkill,
} from './skills-github.js';

/**
 * Skill marketplaces: GitHub repos of SKILL.md folders (Anthropic's skills repo by default, plus
 * any the person adds by owner/repo or URL), browsed, searched and installed without cloning.
 * Installing copies the files into the user skills folder and records the source and version;
 * it never runs anything. Catalogs are cached for a day.
 */

export const DEFAULT_MARKETPLACES: readonly string[] = ['anthropics/skills'];
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface MarketDeps {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  now?: () => number;
}

const cacheSchema = z.record(
  z.string(),
  z.object({ at: z.number(), skills: z.array(z.custom<MarketSkill>()) }),
);
type Cache = z.infer<typeof cacheSchema>;

const cacheFile = (env: NodeJS.ProcessEnv): string =>
  join(resolvePaths(env).configHome, 'cache', 'skills-market.json');

async function readCache(env: NodeJS.ProcessEnv): Promise<Cache> {
  const parsed = cacheSchema.safeParse(await readJson(cacheFile(env)).catch(() => ({})));
  return parsed.success ? parsed.data : {};
}

/** Every marketplace source: the defaults, then the ones the person added. */
export async function marketplaces(env: NodeJS.ProcessEnv): Promise<string[]> {
  const added = (await readSkillsState(env)).marketplaces;
  return [...new Set([...DEFAULT_MARKETPLACES, ...added])];
}

/** Add a marketplace (checked by reading it once); returns its canonical owner/repo. */
export async function addMarketplace(source: string, deps: MarketDeps): Promise<string> {
  const name = repoName(parseRepoRef(source));
  const skills = await catalogFor(name, deps, true);
  await updateSkillsState(deps.env, (s) => ({
    ...s,
    marketplaces: s.marketplaces.includes(name) ? s.marketplaces : [...s.marketplaces, name],
  }));
  return `${name} (${String(skills.length)} skills)`;
}

export async function removeMarketplace(source: string, env: NodeJS.ProcessEnv): Promise<void> {
  const name = repoName(parseRepoRef(source));
  await updateSkillsState(env, (s) => ({
    ...s,
    marketplaces: s.marketplaces.filter((m) => m !== name),
  }));
}

/** One marketplace's skills, including repos its marketplace.json links to (cached). */
async function catalogFor(source: string, deps: MarketDeps, fresh = false): Promise<MarketSkill[]> {
  const now = deps.now?.() ?? Date.now();
  const cache = await readCache(deps.env);
  const hit = cache[source];
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) return hit.skills;
  const ref = parseRepoRef(source);
  const linked = await marketplaceRepos(deps.fetch, ref, deps.env);
  // The marketplace itself must be readable; a repo it links to may be gone.
  const own = await listRepoSkills(deps.fetch, ref, deps.env);
  const lists = await Promise.all(
    linked.map((r) => listRepoSkills(deps.fetch, r, deps.env).catch(() => [])),
  );
  const skills = [...own, ...lists.flat()];
  await writeJsonAtomic(cacheFile(deps.env), { ...cache, [source]: { at: now, skills } });
  return skills;
}

/** Every marketplace skill; a source that can't be read is reported, not fatal. */
export async function catalog(
  deps: MarketDeps,
  fresh = false,
): Promise<{ skills: MarketSkill[]; errors: string[] }> {
  const sources = await marketplaces(deps.env);
  const results = await Promise.all(
    sources.map(async (src) => {
      try {
        return { skills: await catalogFor(src, deps, fresh), error: undefined };
      } catch (err) {
        return { skills: [], error: `${src}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),
  );
  const seen = new Set<string>();
  const skills = results
    .flatMap((r) => r.skills)
    .filter((s) => !seen.has(s.id) && Boolean(seen.add(s.id)));
  return { skills, errors: results.flatMap((r) => (r.error ? [r.error] : [])) };
}

/** Skills whose name, description or repo contains every word of the query. */
export function filterSkills(skills: readonly MarketSkill[], query: string): MarketSkill[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return skills.filter((s) => {
    const hay = `${s.name} ${s.description} ${s.repo}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export async function findMarketSkill(id: string, deps: MarketDeps): Promise<MarketSkill> {
  const { skills } = await catalog(deps);
  const skill = skills.find((s) => s.id === id) ?? skills.find((s) => s.name === id);
  if (!skill) throw new Error(`no marketplace skill "${id}" (try: omnexx skills search <words>)`);
  return skill;
}

/** The skill and its SKILL.md, to read before installing. */
export async function previewMarketSkill(
  id: string,
  deps: MarketDeps,
): Promise<{ skill: MarketSkill; text: string }> {
  const skill = await findMarketSkill(id, deps);
  const path = skill.path === '.' ? 'SKILL.md' : `${skill.path}/SKILL.md`;
  return { skill, text: await fetchRaw(deps.fetch, parseRepoRef(skill.repo), path, deps.env) };
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The folder name a skill installs under. */
export function installName(skill: MarketSkill): string {
  const base = skill.path === '.' ? skill.repo.split('/')[1] : skill.path.split('/').at(-1);
  if (!base || !safeRelativePath(base)) throw new Error(`can't install "${skill.id}": bad folder`);
  return base;
}

/**
 * Copy a marketplace skill's files into `userDir/<name>` (files only: nothing is run) and record
 * where it came from. Refuses to replace an existing skill unless `force`.
 */
export async function installMarketSkill(
  skill: MarketSkill,
  userDir: string,
  deps: MarketDeps,
  force = false,
): Promise<string> {
  const name = installName(skill);
  const dest = join(userDir, name);
  if ((await exists(dest)) && !force)
    throw new Error(`"${name}" is already installed (replace it with --force)`);
  if (skill.files.some((f) => f.size > MAX_FILE_BYTES))
    throw new Error(`"${skill.id}" has a file over ${String(MAX_FILE_BYTES)} bytes; not installed`);
  const ref = parseRepoRef(skill.repo);
  const prefix = skill.path === '.' ? '' : `${skill.path}/`;
  // Download everything first, so a failure leaves the old copy in place.
  const files = await Promise.all(
    skill.files.map(async (f) => ({
      path: f.path,
      data: await fetchRawBytes(deps.fetch, ref, `${prefix}${f.path}`, deps.env),
    })),
  );
  await rm(dest, { recursive: true, force: true });
  for (const f of files) {
    const target = join(dest, ...f.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.data, { mode: 0o644 });
  }
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  await updateSkillsState(deps.env, (s) => ({
    ...s,
    installed: { ...s.installed, [name]: { id: skill.id, sha: skill.sha, installedAt: at } },
  }));
  return name;
}

/** Re-install marketplace skills whose files changed upstream; returns the names updated. */
export async function updateMarketSkills(
  userDir: string,
  deps: MarketDeps,
  only?: string,
): Promise<{ updated: string[]; missing: string[] }> {
  const state = await readSkillsState(deps.env);
  const { skills } = await catalog(deps, true);
  const updated: string[] = [];
  const missing: string[] = [];
  for (const [name, rec] of Object.entries(state.installed)) {
    if (only && only !== name) continue;
    const now = skills.find((s) => s.id === rec.id);
    if (!now) missing.push(name);
    else if (now.sha !== rec.sha) updated.push(await installMarketSkill(now, userDir, deps, true));
  }
  return { updated, missing };
}

/** Forget an installed skill's marketplace record (after removing its folder). */
export async function forgetInstalled(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  await updateSkillsState(env, (s) => ({
    ...s,
    installed: Object.fromEntries(Object.entries(s.installed).filter(([n]) => n !== name)),
  }));
}

export const realFetch: FetchLike = (url, init) => fetch(url, init);
