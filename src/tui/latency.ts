import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../core/atomic.js';

/**
 * How long a model takes to answer, for the editor's "est. 5s" countdown: the last few response
 * times per model, with each request's prompt size. The estimate is the median time, scaled by
 * how this prompt compares with the median prompt (within limits). Every function is pure except
 * the load and save at the bottom.
 */

export interface LatencySample {
  ms: number;
  tokens: number;
}

export type LatencyStats = Readonly<Record<string, readonly LatencySample[]>>;

/** Samples kept per model. */
export const MAX_SAMPLES = 20;
/** A bigger or smaller prompt moves the estimate, but no further than this factor either way. */
const MAX_SCALE = 3;

export function recordLatency(
  stats: LatencyStats,
  model: string,
  sample: LatencySample,
): LatencyStats {
  if (!(sample.ms > 0) || !Number.isFinite(sample.ms)) return stats;
  const kept = [...(stats[model] ?? []), sample].slice(-MAX_SAMPLES);
  return { ...stats, [model]: kept };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Expected milliseconds for a request of `tokens` to `model`, or undefined with no history. */
export function estimateLatency(
  stats: LatencyStats,
  model: string,
  tokens: number,
): number | undefined {
  const samples = stats[model];
  if (!samples?.length) return undefined;
  const ms = median(samples.map((s) => s.ms));
  const typical = median(samples.map((s) => s.tokens));
  const scale =
    typical > 0 && tokens > 0 ? Math.min(MAX_SCALE, Math.max(1 / MAX_SCALE, tokens / typical)) : 1;
  return Math.round(ms * scale);
}

/** Read saved stats; anything missing or malformed counts as no history. */
export async function loadLatency(file: string): Promise<LatencyStats> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).flatMap(([model, list]) =>
        Array.isArray(list)
          ? [
              [
                model,
                list
                  .filter(
                    (s): s is LatencySample =>
                      typeof (s as LatencySample).ms === 'number' &&
                      typeof (s as LatencySample).tokens === 'number',
                  )
                  .slice(-MAX_SAMPLES),
              ],
            ]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export async function saveLatency(file: string, stats: LatencyStats): Promise<void> {
  await writeJsonAtomic(file, stats);
}
