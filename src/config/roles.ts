import { migrateStrategy, type Strategy } from './routing.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { OmnexxPaths } from '../core/paths.js';
import { userConfigFile } from '../core/paths.js';
import { upsertTomlTable } from './toml-file.js';

/**
 * "Advanced: different models per role". Most people keep one ranked list for everything (the
 * /models pool, [pool] in the unified config); a role given its own list here uses it instead,
 * routed by its own mode (see routing.ts). It lives in the unified user config as the [roles]
 * table; the old roles.json is still read (and migrated on startup) so an existing setup
 * keeps working. A role left empty falls back to the pool and config.toml. `helpers` powers
 * subagents, which are off by default.
 */
export const ROLE_NAMES = ['chat', 'planner', 'worker', 'cheap', 'helpers'] as const;
export type Role = (typeof ROLE_NAMES)[number];

/** Files written before the three modes existed have no version; their "priority" was fallback. */
export const ROLES_VERSION = 2;

export interface Roles {
  models: Partial<Record<Role, string[]>>;
  /** How each role routes between its models; unset roles use the pool's mode or the default. */
  strategies: Partial<Record<Role, Strategy>>;
  spreadHelpers: boolean;
}

const REF = /^[a-z][a-z0-9_-]*:\S+$/;
const MAX_PER_ROLE = 20;
const EMPTY: Roles = { models: {}, strategies: {}, spreadHelpers: true };

export const rolesFile = (p: OmnexxPaths): string => join(p.configHome, 'roles.json');

/** Keep only well-formed, distinct refs, in order. */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs = value.filter((r): r is string => typeof r === 'string' && REF.test(r));
  return [...new Set(refs)].slice(0, MAX_PER_ROLE);
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Read legacy roles.json content, migrating old files (no version: "priority" meant fallback). */
export function parseRoles(raw: unknown): Roles {
  const obj = record(raw);
  const legacy = obj.version !== ROLES_VERSION;
  const modelsIn = record(obj.models);
  const strategiesIn = record(obj.strategies);
  const models: Partial<Record<Role, string[]>> = {};
  const strategies: Partial<Record<Role, Strategy>> = {};
  for (const role of ROLE_NAMES) {
    const list = cleanList(modelsIn[role]);
    if (list.length) models[role] = list;
    const s = migrateStrategy(strategiesIn[role], legacy);
    if (s) strategies[role] = s;
  }
  return { models, strategies, spreadHelpers: obj.spreadHelpers !== false };
}

/** The [roles] table of the unified config, when the legacy roles.json is absent. */
async function readRolesTable(p: OmnexxPaths): Promise<unknown> {
  try {
    const data = parseToml(await readFile(userConfigFile(p), 'utf8')) as { roles?: unknown };
    if (data.roles === undefined) return undefined;
    const table = record(data.roles);
    return {
      // The unified file is always the current format: stamp the version so the
      // legacy "priority"-means-fallback migration does not rewrite it.
      version: ROLES_VERSION,
      models: table.models ?? {},
      strategies: table.strategies ?? {},
      spreadHelpers: table.spread_helpers ?? true,
    };
  } catch {
    return undefined;
  }
}

export async function readRoles(p: OmnexxPaths): Promise<Roles> {
  try {
    const raw: unknown = JSON.parse(await readFile(rolesFile(p), 'utf8'));
    if (raw !== null && typeof raw === 'object') return parseRoles(raw);
  } catch {
    // No legacy file (or unreadable): fall through to the unified config.
  }
  const table = await readRolesTable(p);
  return table === undefined ? EMPTY : parseRoles(table);
}

/** Save roles as the editor sends them (already in the current format). */
export async function writeRoles(p: OmnexxPaths, roles: Roles): Promise<Roles> {
  const clean = parseRoles({ ...roles, version: ROLES_VERSION });
  await upsertTomlTable(userConfigFile(p), 'roles', {
    spread_helpers: clean.spreadHelpers,
    models: clean.models,
    strategies: clean.strategies,
  });
  return clean;
}

/** The roles as a config layer: only the roles that were set, so the rest fall through. */
export function rolesLayer(r: Roles): Record<string, unknown> | undefined {
  const models: Record<string, unknown> = {};
  for (const role of ROLE_NAMES) {
    const list = r.models[role];
    if (list?.length) models[role] = list;
  }
  if (!r.spreadHelpers) models.spread_helpers = false;
  if (Object.keys(r.strategies).length) models.routing = r.strategies;
  return Object.keys(models).length ? { models } : undefined;
}
