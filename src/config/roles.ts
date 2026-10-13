import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';

/**
 * Which models power which role, chosen in the editor's settings and kept next to the /models
 * pool (`roles.json`). A role left empty falls back to the pool and config.toml as before.
 * `helpers` powers subagents; with `spreadHelpers`, helpers running at the same time start on
 * different providers, so several providers' quotas are used at once.
 */
export const ROLE_NAMES = ['chat', 'planner', 'worker', 'cheap', 'helpers'] as const;
export type Role = (typeof ROLE_NAMES)[number];

export interface Roles {
  models: Partial<Record<Role, string[]>>;
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
  return { models, spreadHelpers: obj.spreadHelpers !== false };
}

export async function readRoles(p: OmnexxPaths): Promise<Roles> {
  try {
    return parseRoles(JSON.parse(await readFile(rolesFile(p), 'utf8')));
  } catch {
    return { models: {}, spreadHelpers: true };
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
  return Object.keys(models).length ? { models } : undefined;
}

/**
 * The chain for the nth helper started: with several providers in the chain, helper n starts on
 * the (n mod providers)th provider and falls back through the rest in order, so parallel helpers
 * spread over providers instead of all hitting the first.
 */
export function spreadAcrossProviders<T extends { provider: string }>(
  chain: readonly T[],
  n: number,
): T[] {
  const providers = [...new Set(chain.map((m) => m.provider))];
  if (providers.length < 2) return [...chain];
  const lead = providers[n % providers.length];
  return [...chain.filter((m) => m.provider === lead), ...chain.filter((m) => m.provider !== lead)];
}
