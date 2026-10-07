import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';

/** The person's ranked provider:model list, kept apart from config.toml so /models can rewrite it. */
export const rankingFile = (p: OmnexxPaths): string => join(p.configHome, 'models.json');

const REF = /^[a-z][a-z0-9_-]*:\S+$/;

export async function readRanking(p: OmnexxPaths): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(rankingFile(p), 'utf8')) as { ranked?: unknown };
    return Array.isArray(raw.ranked)
      ? raw.ranked.filter((r): r is string => typeof r === 'string' && REF.test(r)).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export async function writeRanking(p: OmnexxPaths, ranked: readonly string[]): Promise<void> {
  const file = rankingFile(p);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ranked: ranked.slice(0, 8) }, null, 2)}\n`);
}

/**
 * The ranking as config: #1 is chat's model, and the whole list is the failover order for every
 * role (planner, worker, cheap) and so for helper agents too.
 */
export function rankingLayer(ranked: readonly string[]): Record<string, unknown> | undefined {
  const [first] = ranked;
  if (!first) return undefined;
  const chain = [...ranked];
  return { models: { chat: first, planner: chain, worker: chain, cheap: chain } };
}
