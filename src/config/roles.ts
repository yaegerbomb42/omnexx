import { STRATEGIES, type Strategy } from './routing.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';

/**
 * Which models power which role, chosen in the editor's settings and kept next to the /models
 * pool (`roles.json`). A role left empty falls back to the pool and config.toml as before.
 * `helpers` powers subagents. Each role also has a routing strategy (see routing.ts): least-busy
 * helpers spread over providers, so several providers' quotas are used at once.
 */
export const ROLE_NAMES = ['chat', 'planner', 'worker', 'cheap', 'helpers'] as const;
export type Role = (typeof ROLE_NAMES)[number];

export interface Roles {
  models: Partial<Record<Role, string[]>>;
  /** How each role routes between its models; unset roles use the default. */
  strategies: Partial<Record<Role, Strategy>>;
  spreadHelpers: boolean;
}

const REF = /^[a-z][a-z0-9_-]*:\S+$/;
const MAX_PER_ROLE = 20;

export const rolesFile = (p: OmnexxPaths): string => join(p.configHome, 'roles.json');

/** Keep only well-formed, distinct refs, in order. */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs = value.filter((r): r is string => typeof r === 'string' && REF.test(r));
  return [...new Set(refs)].slice(0, MAX_PER_ROLE);
}

export function parseRoles(raw: unknown): Roles {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const modelsIn =
    typeof obj.models === 'object' && obj.models !== null
      ? (obj.models as Record<string, unknown>)
      : {};
  const models: Partial<Record<Role, string[]>> = {};
  for (const role of ROLE_NAMES) {
    const list = cleanList(modelsIn[role]);
    if (list.length) models[role] = list;
  }
  const strategiesIn =
    typeof obj.strategies === 'object' && obj.strategies !== null
      ? (obj.strategies as Record<string, unknown>)
      : {};
  const strategies: Partial<Record<Role, Strategy>> = {};
  for (const role of ROLE_NAMES) {
    const s = strategiesIn[role];
    if (typeof s === 'string' && (STRATEGIES as readonly string[]).includes(s))
      strategies[role] = s as Strategy;
  }
  return { models, strategies, spreadHelpers: obj.spreadHelpers !== false };
}

export async function readRoles(p: OmnexxPaths): Promise<Roles> {
  try {
    return parseRoles(JSON.parse(await readFile(rolesFile(p), 'utf8')));
  } catch {
    return { models: {}, strategies: {}, spreadHelpers: true };
  }
}

export async function writeRoles(p: OmnexxPaths, roles: Roles): Promise<Roles> {
  const clean = parseRoles(roles);
  const file = rolesFile(p);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

/** The roles as a config layer: only the roles that were set, so the rest fall through. */
export function rolesLayer(r: Roles): Record<string, unknown> | undefined {
  const models: Record<string, unknown> = {};
  const { chat, planner, worker, cheap, helpers } = r.models;
  if (chat?.[0]) models.chat = chat[0];
  if (planner?.length) models.planner = planner;
  if (worker?.length) models.worker = worker;
  if (cheap?.length) models.cheap = cheap;
  if (helpers?.length) models.helpers = helpers;
  if (!r.spreadHelpers) models.spread_helpers = false;
  if (Object.keys(r.strategies).length) models.routing = r.strategies;
  return Object.keys(models).length ? { models } : undefined;
}
