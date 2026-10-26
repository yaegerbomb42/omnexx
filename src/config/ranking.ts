import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { OmnexxPaths } from '../core/paths.js';
import { userConfigFile } from '../core/paths.js';
import { upsertTomlTable } from './toml-file.js';
import { MAIN_STRATEGIES, migrateStrategy, type MainStrategy, type Strategy } from './routing.js';

/**
 * The person's ranked provider:model list, the one list every role uses unless [roles] gives
 * a role its own. It lives in the unified user config as the [pool] table; the old models.json
 * is still read (and migrated on startup) so an existing setup keeps working.
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

/** The [pool] table of the unified config, when the legacy models.json is absent. */
async function readPoolTable(p: OmnexxPaths): Promise<{ ranked?: unknown; mode?: unknown }> {
  try {
    const data = parseToml(await readFile(userConfigFile(p), 'utf8')) as {
      pool?: { ranked?: unknown; mode?: unknown };
    };
    return data.pool ?? {};
  } catch {
    return {};
  }
}

/** Legacy models.json wins when present; otherwise the unified config's [pool] table. */
async function readPoolJson(p: OmnexxPaths): Promise<{ ranked?: unknown; mode?: unknown }> {
  const legacy = await readFileJson(p);
  if (legacy.ranked !== undefined || legacy.mode !== undefined) return legacy;
  return readPoolTable(p);
}

export async function readPoolMode(p: OmnexxPaths): Promise<PoolMode> {
  return parsePoolMode((await readPoolJson(p)).mode);
}

/** Serialize read-modify-write of the [pool] table so concurrent writers don't clobber each other. */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function writePoolMode(p: OmnexxPaths, mode: PoolMode): Promise<void> {
  return enqueueWrite(async () => save(p, await readRanking(p), mode));
}

export function cleanRanked(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs = value.filter((r): r is string => typeof r === 'string' && REF.test(r));
  return [...new Set(refs)].slice(0, MAX_RANKED);
}

async function save(p: OmnexxPaths, ranked: readonly string[], mode: PoolMode): Promise<void> {
  await upsertTomlTable(userConfigFile(p), 'pool', {
    ranked: cleanRanked(ranked),
    mode,
  });
}

/** Save the list and its mode together (the editor sends both). */
export function writePool(
  p: OmnexxPaths,
  ranked: readonly string[],
  mode: PoolMode,
): Promise<void> {
  return enqueueWrite(() => save(p, ranked, mode));
}

export async function readRanking(p: OmnexxPaths): Promise<string[]> {
  return cleanRanked((await readPoolJson(p)).ranked);
}

export function writeRanking(p: OmnexxPaths, ranked: readonly string[]): Promise<void> {
  return enqueueWrite(async () => save(p, ranked, await readPoolMode(p)));
}

/**
 * The ranking as config: the whole list, in rank order, for chat and every run role (planner,
 * worker, cheap; helpers too, through the worker chain), each routed by the pool's mode.
 * Per-role lists in [roles] override it.
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
