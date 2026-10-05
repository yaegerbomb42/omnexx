import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { buildCodemap } from '../../agent/codemap.js';
import { runPlanner } from '../../agent/planner.js';
import { writeJsonAtomic } from '../../core/atomic.js';
import { createRun } from '../../core/create.js';
import { compactPlanView } from '../../core/plan.js';
import { Run } from '../../core/run.js';
import { UsageError } from '../../errors.js';
import type { ConfigInput } from '../../config/schema.js';
import { selfEntry, spawnDetached } from '../../daemon/detach.js';
import { brand } from '../brand.js';
import { println, type CliIO } from '../io.js';
import { superviseForeground } from './control.js';
import { resolveRunDeps } from '../run-deps.js';
import { EXIT } from '../exit-codes.js';

export interface RunFlags {
  goalFile?: string;
  planOnly?: boolean;
  budget?: string;
  hours?: string;
  gate?: string[];
  sandbox?: string;
  modelWorker?: string;
  push?: string;
  from?: string;
}

export function flagsToConfig(f: RunFlags): ConfigInput {
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0)
      throw new UsageError(`--${name} expects a positive number, got "${v}"`);
    return n;
  };
  const budget = { max_usd: num(f.budget, 'budget'), max_hours: num(f.hours, 'hours') };
  return {
    ...(budget.max_usd !== undefined || budget.max_hours !== undefined
      ? { budget: Object.fromEntries(Object.entries(budget).filter(([, v]) => v !== undefined)) }
      : {}),
    ...(f.gate?.length ? { gates: f.gate.map((run, i) => ({ name: `gate${i + 1}`, run })) } : {}),
    ...(f.sandbox ? { sandbox: f.sandbox as 'host' } : {}),
    ...(f.modelWorker
      ? {
          models: {
            worker: f.modelWorker.includes(':') ? f.modelWorker : `anthropic:${f.modelWorker}`,
          },
        }
      : {}),
    ...(f.push ? { git: { push: f.push as 'none' } } : {}),
  };
}

export async function readGoal(
  io: CliIO,
  goal: string | undefined,
  goalFile: string | undefined,
): Promise<string> {
  if (goal && goalFile) throw new UsageError('give a goal or --goal-file, not both');
  if (goalFile) return readFile(resolve(io.cwd, goalFile), 'utf8');
  if (!goal?.trim())
    throw new UsageError('missing goal', 'omnexx run "make the test suite pass on Node 24"');
  return goal;
}

/** `run --plan-only`: create the run, build the codemap, run the cycle-0 planner, print the plan. */
export async function runPlanOnly(io: CliIO, goal: string, flags: RunFlags): Promise<number> {
  const { paths, clock, deps } = await resolveRunDeps(io, io.cwd, flagsToConfig(flags));
  const store = await createRun({
    paths,
    cwd: io.cwd,
    goal,
    now: clock.now(),
    ...(flags.from ? { from: flags.from } : {}),
  });
  const run = await Run.open(deps, store.runId);
  run.events.emit('run.start', { mode: 'plan-only', repo: run.state.repoName });
  await writeJsonAtomic(store.file('codemap.json'), await buildCodemap(run.worktree));
  await run.setPhase('planning');
  const plan = await runPlanner(run, { kind: 'initial' });
  run.state.status = 'planned';
  await run.setPhase('done');
  run.events.emit('run.finish', { status: 'planned', usd: run.state.spend.usd });
  println(io.stdout, pc.bold(`Run ${run.state.runId} (plan only)`));
  println(io.stdout, compactPlanView(plan, undefined));
  println(io.stdout, '');
  println(
    io.stdout,
    `Planner spend: $${run.state.spend.usd.toFixed(4)}. Plan: ${store.file('plan.json')}`,
  );
  return EXIT.ok;
}

export interface FullRunFlags extends RunFlags {
  detach?: boolean;
  iKnowThereAreNoChecks?: boolean;
}

/** `omnexx run`: create the run, then supervise it here or in a detached process. */
export async function runCommand(io: CliIO, goal: string, flags: FullRunFlags): Promise<number> {
  const { config, paths, clock } = await resolveRunDeps(io, io.cwd, flagsToConfig(flags));
  if (!config.gates.length && !flags.iKnowThereAreNoChecks) {
    throw new UsageError(
      "no gates configured: nothing would check the agent's work",
      'run `omnexx init`, pass --gate "npm test", or --i-know-there-are-no-checks for a single cycle',
    );
  }
  const store = await createRun({
    paths,
    cwd: io.cwd,
    goal,
    now: clock.now(),
    noChecks: !config.gates.length,
    ...(flags.from ? { from: flags.from } : {}),
  });
  if (flags.detach) {
    const pid = spawnDetached(
      io.entry ?? selfEntry(),
      ['supervise', store.runId],
      store.file('supervisor.log'),
      io.env,
    );
    println(io.stdout, store.runId);
    println(
      io.stderr,
      `supervisor pid ${pid}; \`omnexx status ${store.runId}\`, \`omnexx logs -f ${store.runId}\``,
    );
    return EXIT.ok;
  }
  const b = brand(io);
  println(
    io.stderr,
    `${b.green('omnexx')} run ${b.cyan(store.runId)} on ${(await store.readState()).branch}`,
  );
  return superviseForeground(io, store.runId);
}
