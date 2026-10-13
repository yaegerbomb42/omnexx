import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from './base.ts';
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
    args.push('--hours', String(hours), '--push', 'none', '--quiet');
    if (await hasScript(workDir, 'test')) args.push('--gate', 'npm test');

    const start = Date.now();
    const { timedOut } = await this.spawnWithTimeout('node', args, {
      cwd: workDir,
      env: {
        ...process.env,
        OMNEXX_HOME: home,
        OMNEXX_CONFIG_HOME: await benchConfigHome(home, this.opts.beyond ?? false),
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // The run stops itself at --hours; the margin covers planning and teardown.
      timeoutMs: hours * 3_600_000 + 10 * 60_000,
    });
    const wall_ms = Date.now() - start;

    const state = await latestState(home);
    if (!state) throw new Error(`omnexx left no run state in ${home}`);
    return {
      ...metricsFromState(state, wall_ms),
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
async function benchConfigHome(home: string, beyond: boolean): Promise<string> {
  const src =
    process.env.OMNEXX_CONFIG_HOME ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'omnexx');
  const dest = join(home, 'config');
  if (existsSync(src)) await cp(src, dest, { recursive: true });
  else await mkdir(dest, { recursive: true });
  const file = join(dest, 'config.toml');
  const text = await readFile(file, 'utf-8').catch(() => '');
  if (!/^\[beyond\]/m.test(text)) await appendFile(file, `\n[beyond]\nenabled = ${beyond}\n`);
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
