import { join } from 'node:path';
import { z } from 'zod';
import { readTextOr, writeJsonAtomic } from './atomic.js';
import type { OmnexxPaths } from './paths.js';
import { DEFAULT_TOKEN_RATIO, nextTokenRatio, TOKEN_RATIO_MAX, TOKEN_RATIO_MIN } from './tokens.js';

/**
 * Per-model EMA of `promptTokens / estimateTokens(prompt)`, kept beside `latency.json` in the
 * config directory. Its own file: latency and this are written by different processes, and an
 * older omnexx rewriting `latency.json` would drop keys it doesn't know.
 */
export function tokenCalibrationFile(paths: Pick<OmnexxPaths, 'configHome'>): string {
  return join(paths.configHome, 'token-calibration.json');
}

export type TokenRatios = Readonly<Record<string, number>>;

const ratioValue = z.number().positive();

export function tokenRatio(ratios: TokenRatios, model: string): number {
  return ratios[model] ?? DEFAULT_TOKEN_RATIO;
}

/** New map with `model` updated, or undefined when the sample is ignored or changes nothing. */
export function observeTokenRatio(
  ratios: TokenRatios,
  model: string,
  estimated: number,
  actual: number,
): TokenRatios | undefined {
  if (model.length === 0) return undefined;
  const next = nextTokenRatio(tokenRatio(ratios, model), estimated, actual);
  if (next === undefined || ratios[model] === next) return undefined;
  return { ...ratios, [model]: next };
}

const clampRatio = (n: number): number => Math.min(TOKEN_RATIO_MAX, Math.max(TOKEN_RATIO_MIN, n));

/** Saved ratios; a missing or broken file, or a broken entry, counts as no history for that key. */
export async function loadTokenRatios(file: string): Promise<TokenRatios> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readTextOr(file, '{}')) as unknown;
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [model, value] of Object.entries(raw)) {
    const parsed = ratioValue.safeParse(value);
    if (model.length === 0 || !parsed.success) continue;
    out[model] = clampRatio(parsed.data);
  }
  return out;
}

/** Merge `model` onto whatever is already on disk. Errors are the caller's to ignore. */
export async function saveTokenRatio(file: string, model: string, ratio: number): Promise<void> {
  if (model.length === 0 || !Number.isFinite(ratio)) return;
  const disk = await loadTokenRatios(file);
  const next = clampRatio(ratio);
  if (disk[model] === next) return;
  await writeJsonAtomic(file, { ...disk, [model]: next });
}
