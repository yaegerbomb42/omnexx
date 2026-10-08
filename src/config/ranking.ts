import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';

/** The person's ranked provider:model list, kept apart from config.toml so /models can rewrite it. */
export const rankingFile = (p: OmnexxPaths): string => join(p.configHome, 'models.json');

const REF = /^[a-z][a-z0-9_-]*:\S+$/;
/** The pool: every model the person ticked, up to this many. */
export const MAX_RANKED = 64;

/**
 * How the pool is walked. `ordered`: top first, each model until it runs out of quota. `random`:
 * the same, in a shuffled order (reshuffled daily, when quotas reset) so load spreads evenly.
 * `smart`: a local Nimble model picks the best model with quota left for each action, falling
 * back to the pool order when Nimble isn't running.
 */
export type PoolMode = 'ordered' | 'random' | 'smart';
export const POOL_MODES: readonly PoolMode[] = ['ordered', 'random', 'smart'];

async function readFileJson(p: OmnexxPaths): Promise<{ ranked?: unknown; mode?: unknown }> {
  try {
    return JSON.parse(await readFile(rankingFile(p), 'utf8')) as {
      ranked?: unknown;
      mode?: unknown;
    };
  } catch {
    return {};
  }
}

export async function readPoolMode(p: OmnexxPaths): Promise<PoolMode> {
  const mode = (await readFileJson(p)).mode;
  return POOL_MODES.find((m) => m === mode) ?? 'ordered';
}

export async function writePoolMode(p: OmnexxPaths, mode: PoolMode): Promise<void> {
  await save(p, await readRanking(p), mode);
}

async function save(p: OmnexxPaths, ranked: readonly string[], mode: PoolMode): Promise<void> {
  const file = rankingFile(p);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ ranked: ranked.slice(0, MAX_RANKED), mode }, null, 2)}\n`,
  );
}

/** A shuffle every session agrees on for the day: sort by a hash of the day and the ref. */
export function dailyShuffle(refs: readonly string[], now: number): string[] {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = (r: string) => createHash('sha256').update(`${day}|${r}`).digest('hex');
  return [...refs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

export async function readRanking(p: OmnexxPaths): Promise<string[]> {
  const raw = await readFileJson(p);
  return Array.isArray(raw.ranked)
    ? raw.ranked
        .filter((r): r is string => typeof r === 'string' && REF.test(r))
        .slice(0, MAX_RANKED)
    : [];
}

export async function writeRanking(p: OmnexxPaths, ranked: readonly string[]): Promise<void> {
  await save(p, ranked, await readPoolMode(p));
}

/**
 * The ranking as config: #1 is chat's model, and the whole list is the failover order for every
 * role (planner, worker, cheap) and so for helper agents too.
 */
export function rankingLayer(
  ranked: readonly string[],
  mode: PoolMode = 'ordered',
  now = Date.now(),
): Record<string, unknown> | undefined {
  const chain = mode === 'random' ? dailyShuffle(ranked, now) : [...ranked];
  const [first] = chain;
  if (!first) return undefined;
  return { models: { chat: first, planner: chain, worker: chain, cheap: chain } };
}
