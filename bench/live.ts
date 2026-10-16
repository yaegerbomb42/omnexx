import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeterTotals } from './meter.ts';
import { resultsDir } from './results.ts';

/**
 * Live state for `npm run bench:watch`: each run writes `live/<tag>.json` (status, tokens so far)
 * and its agent's output streams into `live/<tag>.log`.
 */

/** Four hard10 tasks that took both omnexx and Cline 1–3 minutes: a quick, varied sample. */
export const QUICK_TASKS = [
  'task-01-ledger-report-bug',
  'task-03-semver-range-issue',
  'task-06-pipeline-scheduler-bugs',
  'task-10-template-engine-issue',
] as const;

/** --quick caps each run at 8 minutes. */
export const QUICK_HOURS = 8 / 60;

export type LiveState = 'queued' | 'running' | 'pass' | 'fail' | 'error';

export interface LiveStatus {
  tag: string;
  task: string;
  agent: string;
  rep: number;
  state: LiveState;
  startedAt?: string;
  finishedAt?: string;
  /** Fresh (uncached) input, cached input and output tokens so far. */
  tokens?: { fresh: number; cached: number; output: number; requests: number };
  error?: string;
}

export const liveDir = (out: string): string => join(resultsDir(out), 'live');

/** File-safe name for a run tag like `task-01/cline/r1`. */
export const liveName = (tag: string): string => tag.replace(/[^A-Za-z0-9._-]/g, '_');

export function tokensFrom(t: MeterTotals): NonNullable<LiveStatus['tokens']> {
  return {
    fresh: Math.max(0, t.prompt - t.cached),
    cached: t.cached,
    output: t.completion,
    requests: t.requests,
  };
}

export async function writeStatus(out: string, status: LiveStatus): Promise<void> {
  const dir = liveDir(out);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${liveName(status.tag)}.json`), JSON.stringify(status));
}

/** Which task ids were asked for, or undefined for all. */
function wantedTasks(opts: {
  task?: string;
  tasks?: string;
  quick?: boolean;
}): string[] | undefined {
  if (opts.task) return [opts.task];
  if (opts.tasks) return opts.tasks.split(',').map((t) => t.trim());
  if (opts.quick) return [...QUICK_TASKS];
  return undefined;
}

/** Which tasks to run: --task one, --tasks a,b,c, --quick the sample, else all. */
export function pickTasks<T extends { id: string }>(
  all: readonly T[],
  opts: { task?: string; tasks?: string; quick?: boolean },
): T[] {
  const wanted = wantedTasks(opts);
  return wanted ? all.filter((t) => wanted.includes(t.id)) : [...all];
}

/** How a finished run shows on the watch page. */
export function finalState(result: { error?: string; metrics: { resolved: boolean } }): LiveState {
  if (result.error) return 'error';
  return result.metrics.resolved ? 'pass' : 'fail';
}

/** Every run shows as queued before any starts, so the page has the whole line-up. */
export async function writeQueued(
  out: string,
  jobs: readonly { tag: string; task: { id: string }; agent: string; rep: number }[],
): Promise<void> {
  await Promise.all(
    jobs.map((job) =>
      writeStatus(out, {
        tag: job.tag,
        task: job.task.id,
        agent: job.agent,
        rep: job.rep,
        state: 'queued',
      }),
    ),
  );
}
