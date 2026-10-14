import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Suite, TaskDef } from './types.ts';

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight. Results come back in input
 * order. `fn` is expected to handle its own errors; one that throws rejects the whole pool.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(`concurrency must be a positive integer, got ${String(concurrency)}`);
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** One (task, agent, rep) run of a bench invocation. */
export interface Job {
  task: TaskDef;
  agent: string;
  /** 1-based repetition number. */
  rep: number;
  /** "task/agent/rN": names the run in logs and in the meter's call log. */
  tag: string;
}

/**
 * Every (task, agent, rep) triple, rep-major so a cut-short run still has whole rounds, with
 * agents interleaved per task so a pool's concurrent runs spread across harnesses.
 */
export function planJobs(
  tasks: readonly TaskDef[],
  agents: readonly string[],
  reps: number,
): Job[] {
  if (!Number.isInteger(reps) || reps < 1)
    throw new Error(`reps must be a positive integer, got ${String(reps)}`);
  return Array.from({ length: reps }, (_, r) => r + 1).flatMap((rep) =>
    tasks.flatMap((task) =>
      agents.map((agent) => ({ task, agent, rep, tag: `${task.id}/${agent}/r${String(rep)}` })),
    ),
  );
}

/** Runs async sections one at a time, in call order (e.g. a read-modify-write of one file). */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Sets each task up once into `templateRoot/<task>` (setup.sh, npm install, git init) and copies
 * that template into every run's work dir, so agents × reps pay for one install per task.
 * Concurrent callers for the same task share the one setup; a failed setup fails them all.
 */
export function cachedSetup(
  suite: Pick<Suite, 'setupTask'>,
  templateRoot: string,
): (task: TaskDef, workDir: string) => Promise<void> {
  const templates = new Map<string, Promise<string>>();
  const template = (task: TaskDef): Promise<string> => {
    const known = templates.get(task.id);
    if (known) return known;
    const dir = join(templateRoot, task.id);
    const made = suite.setupTask(task, dir).then(() => dir);
    templates.set(task.id, made);
    return made;
  };
  return async (task, workDir) => {
    const dir = await template(task);
    await rm(workDir, { recursive: true, force: true });
    // verbatimSymlinks keeps node_modules/.bin links relative, so they point into the copy.
    await cp(dir, workDir, { recursive: true, verbatimSymlinks: true });
  };
}

/** Every line of `text` prefixed with `[tag] `, so interleaved concurrent output stays readable. */
export function tagLines(tag: string, text: string): string {
  return text
    .split('\n')
    .map((line) => `[${tag}] ${line}`)
    .join('\n');
}
