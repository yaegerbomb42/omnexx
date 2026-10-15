import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { resolvePaths } from '../core/paths.js';
import { estimateTokens } from '../core/tokens.js';
import { listSkillsWithSource, type SkillRoots } from '../instructions/skills.js';
import {
  readSkillsState,
  setSkillEnabled,
  updateSkillsState,
} from '../instructions/skills-state.js';
import type { MarketSkill } from '../integrations/skills-github.js';
import {
  addMarketplace,
  catalog,
  filterSkills,
  findMarketSkill,
  forgetInstalled,
  installMarketSkill,
  marketplaces,
  previewMarketSkill,
  realFetch,
  updateMarketSkills,
  type MarketDeps,
} from '../integrations/skills-market.js';
import { gist } from '../tools/extra/skill.js';
import type { CliIO } from './io.js';

/**
 * Skills for the editor's Skills page and `omnexx skills`: every skill omnexx can see (with its
 * source, on/off state and what its catalog line costs), and the marketplace actions.
 */

export const SOURCE_LABEL = {
  'claude-user': 'Claude Code',
  config: '[skills] dirs',
  user: 'omnexx user',
  'claude-repo': 'repo .claude',
  repo: 'repo .omnexx',
} as const;

export interface SkillRow {
  name: string;
  description: string;
  path: string;
  source: keyof typeof SOURCE_LABEL;
  sourceLabel: string;
  enabled: boolean;
  /** Tokens its line in the `skill` tool's catalog costs on every request (0 when off). */
  tokens: number;
  /** Marketplace id when it was installed from one. */
  from?: string;
}

export const userSkillsDir = (env: NodeJS.ProcessEnv): string =>
  join(resolvePaths(env).configHome, 'skills');

export async function skillRoots(io: CliIO): Promise<SkillRoots> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  return {
    repoRoot: io.cwd,
    env: io.env,
    dirs: config.skills.dirs,
    importClaude: config.skills.import_claude,
  };
}

export async function installedSkills(io: CliIO): Promise<SkillRow[]> {
  const [skills, state] = await Promise.all([
    listSkillsWithSource(await skillRoots(io)),
    readSkillsState(io.env),
  ]);
  const off = new Set(state.disabled);
  return skills.map((s) => {
    const from =
      s.source === 'user'
        ? state.installed[dirname(s.path).split('/').at(-1) ?? '']?.id
        : undefined;
    return {
      ...s,
      sourceLabel: SOURCE_LABEL[s.source],
      enabled: !off.has(s.name),
      tokens: off.has(s.name) ? 0 : estimateTokens(`- ${s.name}: ${gist(s.description)}\n`),
      ...(from ? { from } : {}),
    };
  });
}

export async function setEnabled(io: CliIO, name: string, on: boolean): Promise<void> {
  if (!(await installedSkills(io)).some((s) => s.name === name))
    throw new Error(`no skill named "${name}"`);
  await updateSkillsState(io.env, (s) => setSkillEnabled(s, name, on));
}

/** Remove a skill the person added (omnexx user folder only; other sources are left alone). */
export async function removeSkill(io: CliIO, name: string): Promise<void> {
  const skill = (await installedSkills(io)).find((s) => s.name === name);
  if (!skill) throw new Error(`no skill named "${name}"`);
  if (skill.source !== 'user')
    throw new Error(`"${name}" comes from ${skill.sourceLabel}; remove it there`);
  const folder = dirname(skill.path);
  await rm(folder, { recursive: true, force: true });
  await forgetInstalled(folder.split('/').at(-1) ?? name, io.env);
}

/** Marketplace access over the io's fetch (tests pass a fake one), else the real one. */
export const marketDeps = (io: CliIO): MarketDeps => {
  const f = io.fetch;
  return { env: io.env, fetch: f ? (url, init) => f(url, init) : realFetch };
};

/** Install a marketplace skill and switch it on; returns the folder name. */
export async function installSkill(
  io: CliIO,
  id: string,
  deps: MarketDeps,
  force = false,
): Promise<{ name: string; skill: MarketSkill }> {
  const skill = await findMarketSkill(id, deps);
  const name = await installMarketSkill(skill, userSkillsDir(io.env), deps, force);
  await updateSkillsState(io.env, (s) => setSkillEnabled(s, skill.name, true));
  return { name, skill };
}

type Command = { type: string } & Record<string, unknown>;

const str = (c: Command, key: string): string => {
  const v = c[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${c.type}" needs a "${key}" string`);
  return v.trim();
};

/** The chat-server's `skills*` commands; every one answers with a `skills…` message. */
export async function handleSkills(
  io: CliIO,
  c: Command,
  deps: MarketDeps = marketDeps(io),
): Promise<object> {
  const list = async (notice?: string) => ({
    type: 'skills',
    installed: await installedSkills(io),
    marketplaces: await marketplaces(io.env),
    ...(notice ? { notice } : {}),
  });
  switch (c.type) {
    case 'skills':
      return list();
    case 'skillsSearch': {
      const query = typeof c.query === 'string' ? c.query : '';
      const { skills, errors } = await catalog(deps, c.refresh === true);
      return { type: 'skillsMarket', query, skills: filterSkills(skills, query), errors };
    }
    case 'skillsPreview':
      return { type: 'skillsPreview', ...(await previewMarketSkill(str(c, 'id'), deps)) };
    case 'skillsInstall': {
      const { name } = await installSkill(io, str(c, 'id'), deps, c.force === true);
      return list(`installed ${name}`);
    }
    case 'skillsUpdate': {
      const r = await updateMarketSkills(userSkillsDir(io.env), deps);
      return list(r.updated.length ? `updated ${r.updated.join(', ')}` : 'all up to date');
    }
    case 'skillsRemove':
      await removeSkill(io, str(c, 'name'));
      return list(`removed ${str(c, 'name')}`);
    case 'skillsToggle':
      await setEnabled(io, str(c, 'name'), c.on === true);
      return list();
    case 'skillsMarketAdd':
      return list(`added marketplace ${await addMarketplace(str(c, 'source'), deps)}`);
    default:
      throw new Error(`unknown command "${c.type}"`);
  }
}
