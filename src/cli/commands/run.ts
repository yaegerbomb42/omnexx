import { homedir } from 'node:os';
import { startTracking } from '../bootstrap.js';
import { isWritingGoal, resolveWriting } from '../../core/writing.js';
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
import { parseDuration } from '../../config/duration.js';
import type { ConfigInput } from '../../config/schema.js';
import { selfEntry, spawnDetached } from '../../daemon/detach.js';
import { brand } from '../brand.js';
import { EventTail, LiveFeed } from '../../telemetry/feed.js';
import { verbosityFrom } from '../../telemetry/humanize.js';
import { println, type CliIO } from '../io.js';
import { RUN_FLAGS_FILE, superviseForeground } from './control.js';
import { resolveRunDeps } from '../run-deps.js';
import { EXIT } from '../exit-codes.js';
import { bootstrapEmptyProject, isEmptyProject } from '../bootstrap.js';

/** Folders too broad to run in: the home folder and the filesystem root. */
const TOO_BROAD = new Set([resolve(homedir()), resolve('/')]);

export interface RunFlags {
  goalFile?: string;
  planOnly?: boolean;
  budget?: string;
  hours?: string;
  /** Autonomous mode for this long, e.g. "8h" or "2d". */
  for?: string;
  gate?: string[];
  sandbox?: string;
  modelWorker?: string;
  push?: string;
  from?: string;
  /** auto | fast | full */
  plan?: string;
  /** auto | code | writing */
  kind?: string;
  planHelpers?: string;
  planMilestones?: string;
}

export function flagsToConfig(f: RunFlags): ConfigInput {
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0)
      throw new UsageError(`--${name} expects a positive number, got "${v}"`);
    return n;
  };
  const auto = autonomousHours(f);
  const budget = {
    max_usd: num(f.budget, 'budget'),
    max_hours: auto ?? num(f.hours, 'hours'),
    // A day of work is many cycles; the clock is the cap, not the cycle count.
    ...(auto ? { max_cycles: AUTONOMOUS_MAX_CYCLES } : {}),
  };
  return {
    ...(auto ? { autonomous: { enabled: true } } : {}),
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
    ...planFlags(f),
  };
}

const PLAN_MODES = ['auto', 'fast', 'full'] as const;
const RUN_KINDS = ['auto', 'code', 'writing'] as const;

/** `--plan`, `--plan-helpers`, `--plan-milestones` as a [plan] layer. */
function planFlags(f: RunFlags): ConfigInput {
  const int = (v: string | undefined, name: string, min: number, max: number) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new UsageError(`--${name} expects a whole number from ${min} to ${max}, got "${v}"`);
    return n;
  };
  if (f.plan !== undefined && !(PLAN_MODES as readonly string[]).includes(f.plan))
    throw new UsageError(`--plan is one of ${PLAN_MODES.join(', ')}, got "${f.plan}"`);
  if (f.kind !== undefined && !(RUN_KINDS as readonly string[]).includes(f.kind))
    throw new UsageError(`--kind is one of ${RUN_KINDS.join(', ')}, got "${f.kind}"`);
  const plan = {
    ...(f.plan ? { mode: f.plan as (typeof PLAN_MODES)[number] } : {}),
    ...(f.kind ? { kind: f.kind as (typeof RUN_KINDS)[number] } : {}),
    ...(f.planHelpers === undefined ? {} : { helpers: int(f.planHelpers, 'plan-helpers', 0, 8) }),
    ...(f.planMilestones === undefined
      ? {}
      : { milestones: int(f.planMilestones, 'plan-milestones', 1, 30) }),
  };
  return Object.keys(plan).length ? { plan } : {};
}

const AUTONOMOUS_MAX_CYCLES = 100_000;

/** `--for 8h`: autonomous mode's time budget in hours, or undefined without the flag. */
function autonomousHours(f: RunFlags): number | undefined {
  if (f.for === undefined) return undefined;
  if (f.hours !== undefined) throw new UsageError('give --for or --hours, not both');
  let ms: number;
  try {
    ms = parseDuration(f.for);
  } catch {
    throw new UsageError(`--for expects a duration like "45m", "8h" or "2d", got "${f.for}"`);
  }
  if (ms <= 0) throw new UsageError(`--for expects a positive duration, got "${f.for}"`);
  return ms / 3_600_000;
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
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
}

/** `omnexx run`: create the run, then supervise it here or in a detached process. */
export async function runCommand(io: CliIO, goal: string, flags: FullRunFlags): Promise<number> {
  const overrides = flagsToConfig(flags);
  const writingAsked = flags.kind === 'writing' || (flags.kind !== 'code' && isWritingGoal(goal));
  if (await isEmptyProject(io.cwd)) {
    const files = await bootstrapEmptyProject(io.cwd, { writing: writingAsked });
    println(
      io.stderr,
      `empty folder: started a ${writingAsked ? 'writing ' : ''}project (git init, ${files.join(', ')})`,
    );
  }
  if (TOO_BROAD.has(resolve(io.cwd)))
    throw new UsageError(
      `omnexx works inside one project folder, not ${io.cwd}`,
      'cd into the folder you want it to work on (or an empty new one) and run it there',
    );
  if (await startTracking(io.cwd))
    println(
      io.stderr,
      'not a git repository: started one (git init, a .gitignore, a first commit) so every change can be undone',
    );
  const { config, paths, clock } = await resolveRunDeps(io, io.cwd, overrides);
  const writing = resolveWriting(config, goal);
  if (!config.gates.length)
    println(
      io.stderr,
      writing
        ? 'writing run: no tests needed; each piece is checked by its plan and reviewed before it is kept'
        : 'no tests configured: each change is checked by its task checks and a reviewer (add tests with `omnexx init` for stronger checks)',
    );
  const store = await createRun({
    paths,
    cwd: io.cwd,
    goal,
    now: clock.now(),
    noChecks: !config.gates.length,
    writing,
    ...(flags.from ? { from: flags.from } : {}),
  });
  await writeJsonAtomic(store.file(RUN_FLAGS_FILE), overrides);
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
  // The live feed tails the run's own event log, so it shows exactly what `logs -f` would.
  const feed = new LiveFeed(new EventTail(store.eventsPath), {
    out: io.stderr,
    brand: b,
    verbosity: verbosityFrom(flags),
    footer: io.isTTY,
  });
  feed.start();
  try {
    return await superviseForeground(io, store.runId, undefined, () => feed.stop());
  } finally {
    await feed.stop();
  }
}
