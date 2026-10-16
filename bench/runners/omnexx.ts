import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from './base.ts';
import { meterMetrics, type Meter } from '../meter-metrics.ts';
import { efficiency, readRunEvents } from '../efficiency.ts';
import { providerOutageMs } from '../outage.ts';
import type { AgentRunOutput, BenchmarkResult, TaskDef } from '../types.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(REPO_ROOT, 'dist/cli.js');

interface RunState {
  runId: string;
  worktree: string;
  status: string;
  spend: {
    usd: number;
    tokens: { uncached: number; cacheWrite: number; cacheRead: number; output: number };
  };
}

export interface OmnexxRunnerOptions {
  /** Run-level cap, passed as `--budget`. */
  budgetUsd?: number;
  /** Wall-clock cap, passed as `--hours`. */
  hours?: number;
  /** `OMNEXX_HOME` for bench runs, so they never mix with the user's own runs. */
  home?: string;
  /** Keep improving after the goal is met (off: the bench measures the cost of meeting the goal). */
  beyond?: boolean;
  /** One model for every role; the user's pool and roles are then left out entirely. */
  model?: string | undefined;
  /** lean: 0.8 defaults (codemap optional). full: every context section pinned (pre-0.8). */
  context?: 'lean' | 'full';
  /** A metering proxy every model call goes through; `model` is then that endpoint's model id. */
  meter?: Meter | undefined;
  /** Keep the user's judge (e.g. Nimble). Off by default so only the pinned model makes calls. */
  judge?: boolean;
}

/**
 * Runs `omnexx run` in the foreground on the task repo with the repo's own `npm test` as the gate
 * (what a user would configure; the hidden check stays hidden). Metrics come from the run's
 * state.json; the work is judged in the run's worktree, where omnexx commits.
 */
export class OmnexxRunner extends AgentRunner {
  private readonly opts: OmnexxRunnerOptions;

  constructor(opts: OmnexxRunnerOptions = {}) {
    super('omnexx');
    this.opts = opts;
  }

  override async isAvailable(): Promise<boolean> {
    if (!existsSync(CLI)) return false;
    const { stdout } = await this.spawnWithTimeout('node', [CLI, '--version'], {
      timeoutMs: 10_000,
    });
    return stdout.trim().length > 0;
  }

  override async run(_task: TaskDef, workDir: string, goal: string): Promise<AgentRunOutput> {
    const home = this.opts.home ?? (await mkdtemp(join(tmpdir(), 'omnexx-bench-')));
    await mkdir(home, { recursive: true });
    const goalFile = join(home, `goal-${Date.now()}.md`);
    await writeFile(goalFile, goal, 'utf-8');
    const hours = this.opts.hours ?? 0.5;
    const args = [
      CLI,
      'run',
      '--goal-file',
      goalFile,
      '--budget',
      String(this.opts.budgetUsd ?? 2),
    ];
    // Not --quiet: the live feed is what bench:watch shows.
    args.push('--hours', String(hours), '--push', 'none');
    if (await hasScript(workDir, 'test')) args.push('--gate', 'npm test');

    this.opts.meter?.reset();
    const start = Date.now();
    const { timedOut } = await this.spawnWithTimeout('node', args, {
      cwd: workDir,
      env: {
        ...process.env,
        OMNEXX_HOME: home,
        OMNEXX_CONFIG_HOME: await benchConfigHome(home, {
          beyond: this.opts.beyond ?? false,
          model: this.opts.meter ? `bench:${this.opts.model ?? ''}` : this.opts.model,
          context: this.opts.context ?? 'lean',
          judge: this.opts.judge ?? false,
          endpoint: this.opts.meter?.url,
        }),
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // The run stops itself at --hours; the margin covers planning and teardown.
      timeoutMs: hours * 3_600_000 + 10 * 60_000,
    });
    const wall_ms = Date.now() - start;

    // Keep the run's events and state with the results, so each call traces to a cycle.
    await saveRunLog(home, `${workDir}.run`).catch((e: unknown) => {
      console.warn(`  could not save the omnexx run log: ${String(e)}`);
    });
    const state = await latestState(home);
    if (!state) throw new Error(`omnexx left no run state in ${home}`);
    const metrics = this.opts.meter
      ? meterMetrics(this.opts.meter.totals(), wall_ms)
      : metricsFromState(state, wall_ms);
    const events = await readRunEvents(`${workDir}.run`);
    const outage = providerOutageMs(events);
    const eff = efficiency(events, { start, end: start + wall_ms });
    return {
      ...metrics,
      ...(outage ? { provider_outage_ms: outage } : {}),
      ...(eff ? { efficiency: eff } : {}),
      interventions: timedOut ? 1 : 0,
      resultDir: state.worktree,
    };
  }
}

/** Token and cost metrics from a run's state.json. `tokens_in` is uncached input incl. cache writes. */
export function metricsFromState(state: RunState, wall_ms: number): BenchmarkResult {
  const t = state.spend.tokens;
  return {
    resolved: false,
    usd: state.spend.usd,
    tokens_in: t.uncached + t.cacheWrite,
    tokens_out: t.output,
    cached: t.cacheRead,
    wall_ms,
    interventions: 0,
  };
}

/**
 * A copy of the user's config (their providers, models and quota state) with beyond mode set,
 * so a bench run never edits the real config.
 */
/** Editor-set files that would outrank config.toml; a pinned model leaves them all out. */
const POOL_FILES = ['models.json', 'roles.json', 'context-sections.json'];
const ALL_PINNED = ['role', 'codemap', 'intent', 'lessons', 'progress'];

/** The copy's own [name] tables (and their sub-tables) out, e.g. so a pinned model is the only one. */
export function withoutTables(toml: string, names: readonly string[]): string {
  let skipping = false;
  return toml
    .split('\n')
    .filter((line) => {
      const header = /^\s*\[+([^\]]+)\]+\s*$/.exec(line)?.[1]?.trim();
      if (header !== undefined)
        skipping = names.some((n) => header === n || header.startsWith(`${n}.`));
      return !skipping;
    })
    .join('\n');
}

export function withoutModelsTables(toml: string): string {
  return withoutTables(toml, ['models']);
}

/** Files in a user's config home that are personal state, not configuration. */
const PERSONAL_STATE = [
  'agent-settings.json',
  'quota.json',
  'sticky-pool.json',
  'latency.json',
  'run-history.json',
];

async function benchConfigHome(
  home: string,
  o: {
    beyond: boolean;
    model?: string | undefined;
    context: 'lean' | 'full';
    judge: boolean;
    endpoint?: string | undefined;
  },
): Promise<string> {
  const src =
    process.env.OMNEXX_CONFIG_HOME ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'omnexx');
  const dest = join(home, 'config');
  if (existsSync(src)) await cp(src, dest, { recursive: true });
  else await mkdir(dest, { recursive: true });
  // Personal settings and runtime state would make runs depend on whoever runs the bench:
  // the agent sliders, which models are benched for quota, sticky picks, latency history.
  await Promise.all(PERSONAL_STATE.map((f) => rm(join(dest, f), { force: true })));
  const file = join(dest, 'config.toml');
  let text = await readFile(file, 'utf-8').catch(() => '');
  if (o.model) {
    // Only this model may be called: no pool, no roles, nothing that could reach a paid one.
    await Promise.all(POOL_FILES.map((f) => rm(join(dest, f), { force: true })));
    text = withoutModelsTables(text);
    const m = JSON.stringify(o.model);
    text += `\n[models]\nplanner = ${m}\nworker = ${m}\ncheap = ${m}\nhelpers = ${m}\nchat = ${m}\n`;
  }
  if (!o.judge) text = withoutTables(text, ['judge']);
  if (o.endpoint)
    // The meter listens on 127.0.0.1, which would turn the stall cut-off off: the upstream is remote.
    text += `\n[providers.endpoints.bench]\nkind = "openai"\nbase_url = ${JSON.stringify(o.endpoint)}\nfree = true\nstall_timeout = "3m"\n`;
  if (o.context === 'full')
    text += `\n[context.sections]\n${ALL_PINNED.map((s) => `${s} = "pinned"`).join('\n')}\n`;
  if (!/^\[beyond\]/m.test(text)) text += `\n[beyond]\nenabled = ${String(o.beyond)}\n`;
  await writeFile(file, text);
  return dest;
}

async function hasScript(dir: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return Boolean(pkg.scripts?.[name]);
  } catch {
    return false;
  }
}

/** Copies the newest run folder (events.jsonl, state.json, progress) to `dest`; no-op if none. */
export async function saveRunLog(home: string, dest: string): Promise<void> {
  const last = (await readdir(join(home, 'runs')).catch(() => [])).sort().at(-1);
  if (!last) return;
  await cp(join(home, 'runs', last), dest, { recursive: true });
}

async function latestState(home: string): Promise<RunState | undefined> {
  const runs = (await readdir(join(home, 'runs')).catch(() => [])).sort();
  const last = runs.at(-1);
  if (!last) return undefined;
  return JSON.parse(await readFile(join(home, 'runs', last, 'state.json'), 'utf-8')) as RunState;
}

/** Create a fake omnexx runner for testing. */
export function createFakeOmnexxRunner(overrideMetrics?: Partial<BenchmarkResult>): AgentRunner {
  const baseMetrics: BenchmarkResult = {
    resolved: true,
    usd: 0.05,
    tokens_in: 10_000,
    tokens_out: 2_000,
    cached: 8_000,
    wall_ms: 100,
    interventions: 0,
  };

  class FakeOmnexxRunner extends AgentRunner {
    constructor() {
      super('omnexx');
    }

    override isAvailable(): Promise<boolean> {
      return Promise.resolve(true);
    }

    override run(): Promise<AgentRunOutput> {
      return Promise.resolve({ ...baseMetrics, ...overrideMetrics });
    }
  }

  return new FakeOmnexxRunner();
}
