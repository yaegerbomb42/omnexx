import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic.js';
import type { OmnexxPaths } from './paths.js';

/**
 * What finished runs (and chat work after an approved plan) looked like and what they took, for
 * the "est. ~3 min, ~40k tokens, ~$0.02" line before the next one. Kept next to latency.json
 * (the per-request reply times) in its own file: the two are written by different processes, and
 * an older omnexx rewriting latency.json would drop keys it doesn't know.
 */

export const runSampleSchema = z.object({
  at: z.number(),
  /** A supervised run, or chat work started by approving a plan. */
  kind: z.enum(['run', 'chat']),
  model: z.string(),
  goalChars: z.number().nonnegative(),
  /** Planned (milestones and tasks), not finished on the fast path. */
  planned: z.boolean(),
  /** Plan nodes (run) or todo items (chat). */
  nodes: z.number().int().nonnegative(),
  repoFiles: z.number().int().nonnegative(),
  wallMs: z.number().positive(),
  /** Uncached input, cache writes and output. */
  freshTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative(),
  usd: z.number().nonnegative(),
});
export type RunSample = z.infer<typeof runSampleSchema>;

export type RunHistory = readonly RunSample[];

/** Samples kept, newest last. */
export const MAX_RUN_SAMPLES = 200;

export function runHistoryFile(paths: OmnexxPaths): string {
  return join(paths.configHome, 'run-history.json');
}

/** A new history with `sample` added (invalid samples are ignored). Never mutates. */
export function recordRun(history: RunHistory, sample: RunSample): RunHistory {
  if (!runSampleSchema.safeParse(sample).success) return history;
  return [...history, sample].slice(-MAX_RUN_SAMPLES);
}

/** Saved samples; a missing or broken file, or a broken entry, counts as no history. */
export async function loadRunHistory(file: string): Promise<RunHistory> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((s) => {
      const parsed = runSampleSchema.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(-MAX_RUN_SAMPLES);
}

/** Load, add, save. Errors are the caller's to ignore: history is a nicety, never a failure. */
export async function appendRunSample(file: string, sample: RunSample): Promise<void> {
  await writeJsonAtomic(file, recordRun(await loadRunHistory(file), sample));
}
