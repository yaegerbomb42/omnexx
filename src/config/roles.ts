import { migrateStrategy, type Strategy } from './routing.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';

/**
 * "Advanced: different models per role". Most people keep one ranked list for everything (the
 * /models pool, models.json); a role given its own list here uses it instead, routed by its own
 * mode (see routing.ts). Kept next to the pool as `roles.json`. A role left empty falls back to
 * the pool and config.toml. `helpers` powers subagents, which are off by default.
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

/** Read roles.json content, migrating old files (no version: "priority" meant fallback). */
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

export async function readRoles(p: OmnexxPaths): Promise<Roles> {
  try {
    return parseRoles(JSON.parse(await readFile(rolesFile(p), 'utf8')));
  } catch {
    return EMPTY;
  }
}

/** Save roles as the editor sends them (already in the current format). */
export async function writeRoles(p: OmnexxPaths, roles: Roles): Promise<Roles> {
  const clean = parseRoles({ ...roles, version: ROLES_VERSION });
  const file = rolesFile(p);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: ROLES_VERSION, ...clean }, null, 2)}\n`);
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
