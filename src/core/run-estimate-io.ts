import { trackedFiles } from '../agent/codemap.js';
import type { OmnexxConfig } from '../config/schema.js';
import { tryFastPath } from './fast-path.js';
import type { OmnexxPaths } from './paths.js';
import { isTask, planCounts, type Plan } from './plan.js';
import { estimateRun, formatRemaining, type RunEstimate } from './run-estimate.js';
import { appendRunSample, loadRunHistory, runHistoryFile, type RunSample } from './run-history.js';
import type { RunState, RunStore } from './run-store.js';

/** The ref a run's worker starts on: what estimates are matched by. */
export function workerRef(config: OmnexxConfig): string {
  const w = config.models.worker;
  return (typeof w === 'string' ? w : w[0]) ?? '?';
}

/** Files in the repo (git-tracked, vendored left out); 0 when it can't be read. */
export async function repoFileCount(root: string): Promise<number> {
  return trackedFiles(root)
    .then((f) => f.length)
    .catch(() => 0);
}

/** The estimate for a run about to start on `goal` in `cwd`, or undefined with no history. */
export async function estimateForRun(
  paths: OmnexxPaths,
  config: OmnexxConfig,
  cwd: string,
  goal: string,
): Promise<RunEstimate | undefined> {
  const [history, repoFiles] = await Promise.all([
    loadRunHistory(runHistoryFile(paths)),
    repoFileCount(cwd),
  ]);
  // A fast-path run may still fall back to planning, so only a sure plan narrows the match.
  const fast = tryFastPath(config, goal);
  return estimateRun(history, {
    kind: 'run',
    model: workerRef(config),
    goalChars: goal.trim().length,
    repoFiles,
    ...(fast ? {} : { planned: true }),
  });
}

/** What a finished run took, as a history sample. */
export function sampleForRun(
  state: RunState,
  plan: Plan | undefined,
  facts: { model: string; goalChars: number; repoFiles: number; at: number },
): RunSample {
  const t = state.spend.tokens;
  return {
    at: facts.at,
    kind: 'run',
    model: facts.model,
    goalChars: facts.goalChars,
    planned: state.fastPath !== 'tried',
    nodes: plan ? plan.nodes.filter(isTask).length : 0,
    repoFiles: facts.repoFiles,
    wallMs: state.activeMs,
    freshTokens: t.uncached + t.cacheWrite + t.output,
    cachedTokens: t.cacheRead,
    usd: state.spend.usd,
  };
}

/**
 * Add a finished run to the history. Runs stopped by the user, or that did no work, would skew
 * the estimates and are left out. Never throws: history is a nicety.
 */
export async function recordFinishedRun(
  paths: OmnexxPaths,
  sample: RunSample,
  status: string,
): Promise<void> {
  if (status === 'user-stop' || status === 'error' || status === 'failed' || sample.wallMs <= 0)
    return;
  await appendRunSample(runHistoryFile(paths), sample).catch(() => undefined);
}

/** Events after which the time left is worth saying again. */
export const PROGRESS_EVENTS: ReadonlySet<string> = new Set(['plan.written', 'task.done']);

/** "~2 min left" for a run from its plan's finished tasks, or undefined with nothing to go on. */
export async function remainingForRun(
  store: RunStore,
  estimate: RunEstimate | undefined,
  elapsedMs: number,
): Promise<string | undefined> {
  const plan = await store.readPlan().catch(() => undefined);
  const c = plan ? planCounts(plan) : undefined;
  return formatRemaining(estimate, { elapsedMs, done: c?.done ?? 0, total: c?.tasks ?? 0 });
}

/** The estimate for a run already under way (attaching to it), from its goal and checkout. */
export async function estimateForStore(
  paths: OmnexxPaths,
  config: OmnexxConfig,
  store: RunStore,
): Promise<RunEstimate | undefined> {
  const [goal, state] = await Promise.all([store.readGoal(), store.readState()]);
  return estimateForRun(paths, config, state.worktree, goal.text);
}
