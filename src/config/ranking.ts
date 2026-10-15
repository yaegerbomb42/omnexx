import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';
import { MAIN_STRATEGIES, migrateStrategy, type MainStrategy, type Strategy } from './routing.js';

/**
 * The person's ranked provider:model list, the one list every role uses unless roles.json gives
 * a role its own, kept apart from config.toml so /models and the editor can rewrite it.
 */
export const rankingFile = (p: OmnexxPaths): string => join(p.configHome, 'models.json');

const REF = /^[a-z][a-z0-9_-]*:\S+$/;
/** The pool: every model the person ticked, up to this many. */
export const MAX_RANKED = 64;

/**
 * How the pool is used (routing.ts has the details): `random` any model each call, `priority` #1
 * first each call, `fallback` #1 until its quota or rate limit runs out (the default). `smart`
 * (kept for old settings, not offered): a local Nimble model picks per action, falling back to the
 * pool order when Nimble isn't running. Old files saying `ordered` read as `fallback`.
 */
export type PoolMode = MainStrategy | 'smart';
/** The modes /models and the editor cycle through. */
export const POOL_MODES: readonly MainStrategy[] = MAIN_STRATEGIES;

export function parsePoolMode(value: unknown): PoolMode {
  if (value === 'smart') return 'smart';
  const s = migrateStrategy(value, false);
  return POOL_MODES.find((m) => m === s) ?? 'fallback';
}

/** The next mode when cycling (smart, not offered, moves on to the first one). */
export function nextPoolMode(mode: PoolMode): MainStrategy {
  const i = POOL_MODES.indexOf(mode as MainStrategy);
  return POOL_MODES[(i + 1) % POOL_MODES.length] ?? 'fallback';
}

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
  return parsePoolMode((await readFileJson(p)).mode);
}

export async function writePoolMode(p: OmnexxPaths, mode: PoolMode): Promise<void> {
  await save(p, await readRanking(p), mode);
}

function cleanRanked(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs = value.filter((r): r is string => typeof r === 'string' && REF.test(r));
  return [...new Set(refs)].slice(0, MAX_RANKED);
}

async function save(p: OmnexxPaths, ranked: readonly string[], mode: PoolMode): Promise<void> {
  const file = rankingFile(p);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ranked: cleanRanked(ranked), mode }, null, 2)}\n`);
}

/** Save the list and its mode together (the editor sends both). */
export async function writePool(
  p: OmnexxPaths,
  ranked: readonly string[],
  mode: PoolMode,
): Promise<void> {
  await save(p, ranked, mode);
}

export async function readRanking(p: OmnexxPaths): Promise<string[]> {
  return cleanRanked((await readFileJson(p)).ranked);
}

export async function writeRanking(p: OmnexxPaths, ranked: readonly string[]): Promise<void> {
  await save(p, ranked, await readPoolMode(p));
}

/**
 * The ranking as config: the whole list, in rank order, for chat and every run role (planner,
 * worker, cheap; helpers too, through the worker chain), each routed by the pool's mode.
 * Per-role lists in roles.json override it.
 */
export function rankingLayer(
  ranked: readonly string[],
  mode: PoolMode = 'fallback',
): Record<string, unknown> | undefined {
  if (!ranked.length) return undefined;
  const chain = [...ranked];
  const strategy: Strategy = mode === 'smart' ? 'fallback' : mode;
  return {
    models: {
      chat: chain,
      planner: chain,
      worker: chain,
      cheap: chain,
      routing: { chat: strategy, planner: strategy, worker: strategy, cheap: strategy },
    },
  };
}
