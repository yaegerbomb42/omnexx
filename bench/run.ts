import { program } from 'commander';
import { join, resolve } from 'node:path';
import { getHard10Suite, getJimmy10Suite, getWeb5Suite } from './suites/index.ts';
import { OmnexxRunner } from './runners/omnexx.ts';
import {
  anthropicEndpointFromEnv,
  ClaudeCodeRunner,
  type AnthropicEndpoint,
} from './runners/claude-code.ts';
import { CodexRunner } from './runners/codex.ts';
import { ClineRunner } from './runners/cline.ts';
import { OpenHandsRunner } from './runners/openhands.ts';
import { endpointFromEnv, startMeter, type Meter } from './meter.ts';
import { cachedSetup, planJobs, runPool, tagLines, type Job } from './pool.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { liveDir, liveName, pickTasks, QUICK_HOURS, tokensFrom, writeStatus } from './live.ts';
import { createResultsWriter, resultsDir } from './results.ts';
import type { BenchConfig, Suite, TaskRunResult } from './types.ts';
import type { AgentRunner } from './runners/base.ts';

const SUITES: Record<string, () => Suite> = {
  jimmy10: getJimmy10Suite,
  web5: getWeb5Suite,
  hard10: getHard10Suite,
};

interface RunnerOpts {
  hours: number;
  budget: number;
  model?: string | undefined;
  context: 'lean' | 'full';
  meter?: Meter | undefined;
  judge: boolean;
  /** claude-code: the endpoint's Anthropic-compatible URL (PREFIX_ANTHROPIC_BASE_URL). */
  anthropic?: AnthropicEndpoint | undefined;
  /** Whether --endpoint was given: claude-code then refuses to fall back to the user's login. */
  endpointGiven: boolean;
}

function needMeter(o: RunnerOpts): { meter: Meter; model: string; hours: number } {
  if (!o.meter || !o.model)
    throw new Error('this agent needs --endpoint <PREFIX> (PREFIX_BASE_URL, _MODEL, _API_KEY set)');
  return { meter: o.meter, model: o.model, hours: o.hours };
}

const RUNNERS: Record<string, (o: RunnerOpts) => AgentRunner> = {
  omnexx: (o) =>
    new OmnexxRunner({
      hours: o.hours,
      budgetUsd: o.budget,
      model: o.model,
      context: o.context,
      meter: o.meter,
      judge: o.judge,
    }),
  cline: (o) => new ClineRunner(needMeter(o)),
  openhands: (o) => new OpenHandsRunner(needMeter(o)),
  'claude-code': (o) => {
    // Without an Anthropic-format URL, claude would silently bill the user's own login instead
    // of the endpoint every other agent uses.
    if (o.endpointGiven && !o.anthropic)
      throw new Error(
        'claude-code speaks only the Anthropic Messages API: set PREFIX_ANTHROPIC_BASE_URL (e.g. https://api.deepseek.com/anthropic)',
      );
    return new ClaudeCodeRunner(o.anthropic);
  },
  codex: () => new CodexRunner(),
};

interface Opts {
  suite: string;
  agents: string;
  out: string;
  task?: string;
  tasks?: string;
  quick?: boolean;
  dryRun?: boolean;
  hours: string;
  budget: string;
  model?: string;
  context: string;
  endpoint?: string;
  judge?: boolean;
  concurrency: string;
  reps: string;
}

/** 61_234 → "61k". */
const fmtK = (n: number): string => (n >= 1_000 ? `${String(Math.round(n / 1_000))}k` : String(n));

const ZERO = { usd: 0, tokens_in: 0, tokens_out: 0, cached: 0, wall_ms: 0, interventions: 0 };

async function main(): Promise<void> {
  program
    .name('bench')
    .description('Omnexx benchmark runner')
    .requiredOption('--suite <name>', `suite: ${Object.keys(SUITES).join(' | ')}`)
    .requiredOption('--agents <list>', `comma-separated: ${Object.keys(RUNNERS).join(',')}`)
    .requiredOption('--out <dir>', 'name for this result set: written to bench/results/<name>')
    .option('--task <id>', 'run only this task')
    .option('--tasks <ids>', 'run only these tasks (comma-separated)')
    .option(
      '--quick',
      'a 5-10 minute check: 4 varied tasks, every run at once, 8 minutes per run (hard10)',
    )
    .option('--hours <n>', 'omnexx wall-clock cap per task', '0.5')
    .option('--budget <usd>', 'omnexx spend cap per task', '2')
    .option('--model <ref>', 'omnexx: one model for every role, e.g. ollama:gpt-oss:120b-cloud')
    .option(
      '--context <mode>',
      'omnexx: lean (0.8 defaults) or full (every section pinned)',
      'lean',
    )
    .option(
      '--endpoint <prefix>',
      'one OpenAI-compatible endpoint for every agent, metered the same way, from env vars PREFIX_BASE_URL, PREFIX_MODEL, PREFIX_API_KEY',
    )
    .option('--judge', "omnexx: keep the user's judge (e.g. Nimble) on")
    .option(
      '--concurrency <n>',
      'runs in flight at once, each in its own work dir with its own meter',
      '4',
    )
    .option('--reps <n>', 'run every task × agent pair n times; results are tagged by rep', '1')
    .option('--dry-run', 'show what would run without running it')
    .parse();
  const opts = program.opts<Opts>();
  const config: BenchConfig = {
    suite: opts.suite,
    agents: opts.agents.split(',').map((a) => a.trim()),
    out: resolve(opts.out),
  };

  const makeSuite = SUITES[config.suite];
  if (!makeSuite) fail(`Unknown suite: ${config.suite}`);
  const suite = makeSuite();

  const endpoint = opts.endpoint ? endpointFromEnv(process.env, opts.endpoint) : undefined;
  if (endpoint) await mkdir(resultsDir(config.out), { recursive: true });
  const callsLog = join(resultsDir(config.out), 'calls.jsonl');
  if (opts.context !== 'lean' && opts.context !== 'full') fail('--context is lean or full');
  const quick = opts.quick === true;
  const concurrency = quick ? 64 : positiveInt('--concurrency', opts.concurrency);
  const reps = positiveInt('--reps', opts.reps);
  const runnerOpts: RunnerOpts = {
    hours: quick ? QUICK_HOURS : Number(opts.hours),
    budget: Number(opts.budget),
    model: endpoint?.model ?? opts.model,
    context: opts.context,
    judge: opts.judge ?? false,
    anthropic: opts.endpoint ? anthropicEndpointFromEnv(process.env, opts.endpoint) : undefined,
    endpointGiven: opts.endpoint !== undefined,
  };
  // A throwaway meter only so runners that need one can be built for the availability check.
  const probe = endpoint ? await startMeter(endpoint) : undefined;
  try {
    for (const name of config.agents) {
      const runner = makeRunner(name, { ...runnerOpts, meter: probe });
      if (!(await runner.isAvailable())) console.warn(`Warning: agent '${name}' is not available`);
    }
  } finally {
    await probe?.close();
  }

  const tasks = pickTasks(await suite.loadTasks(), opts);
  if (!tasks.length) fail('No tasks to run');
  const jobs = planJobs(tasks, config.agents, reps);

  console.log(`Suite ${config.suite}; agents ${config.agents.join(', ')}; out ${config.out}`);
  console.log(`Tasks: ${tasks.map((t) => t.id).join(', ')}`);
  console.log(
    `${String(jobs.length)} runs (${String(reps)} rep(s)), ${String(Math.min(concurrency, jobs.length))} at a time`,
  );
  if (opts.dryRun) {
    for (const job of jobs) console.log(`  ${job.tag}`);
    return;
  }

  const writer = createResultsWriter(config);
  const work = join(resultsDir(config.out), 'work', config.suite);
  // One setup (and npm install) per task, copied into each run's own work dir.
  const setup = cachedSetup(suite, join(work, '.templates'));
  const runJob = async (job: Job): Promise<void> => {
    const { task, agent, rep, tag } = job;
    const say = (line: string): void => {
      console.log(tagLines(tag, line));
    };
    // Its own work dir and its own meter (own port, own totals), so concurrent runs never share.
    const workDir = join(work, task.id, agent, `r${String(rep)}`);
    const meter = endpoint ? await startMeter(endpoint, callsLog, tag) : undefined;
    const startedAt = new Date().toISOString();
    const base = { taskId: task.id, suite: config.suite, agent, rep, startedAt };
    const live = { tag, task: task.id, agent, rep };
    const logFile = join(liveDir(config.out), `${liveName(tag)}.log`);
    await writeStatus(config.out, { ...live, state: 'running', startedAt });
    await writeFile(logFile, '');
    const ticker = setInterval(() => {
      if (meter)
        void writeStatus(config.out, {
          ...live,
          state: 'running',
          startedAt,
          tokens: tokensFrom(meter.totals()),
        });
    }, 2_000);
    let result: TaskRunResult;
    try {
      say('start');
      const runner = makeRunner(agent, { ...runnerOpts, meter });
      runner.liveLog = logFile;
      await setup(task, workDir);
      const goal = await suite.getGoal(task);
      // The agent works; the suite's hidden check decides whether it resolved the task.
      const { resultDir, ...metrics } = await runner.run(task, workDir, goal);
      const resolved = await suite.checkTask(task, resultDir ?? workDir);
      result = {
        ...base,
        metrics: { ...metrics, resolved },
        finishedAt: new Date().toISOString(),
      };
      say(`${resolved ? 'PASS' : 'FAIL'} ${summary(metrics)}`);
    } catch (error) {
      console.error(tagLines(tag, `ERROR ${String(error)}`));
      result = {
        ...base,
        metrics: { ...ZERO, resolved: false },
        finishedAt: new Date().toISOString(),
        error: String(error),
      };
    } finally {
      clearInterval(ticker);
    }
    const tokens = meter ? tokensFrom(meter.totals()) : undefined;
    await meter?.close();
    await writeStatus(config.out, {
      ...live,
      state: result.error ? 'error' : result.metrics.resolved ? 'pass' : 'fail',
      startedAt,
      finishedAt: result.finishedAt,
      ...(tokens ? { tokens } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    await writer.writeResult(result);
  };
  for (const job of jobs)
    await writeStatus(config.out, {
      tag: job.tag,
      task: job.task.id,
      agent: job.agent,
      rep: job.rep,
      state: 'queued',
    });
  console.log(`Watch live: npm run bench:watch -- --out ${config.out}`);
  await runPool(jobs, concurrency, runJob);
  console.log(`\nResults: ${writer.getOutDir()}/${writer.getRunId()}.md`);
}

/** Fresh tokens are what a run really costs; cache reads (billed ~1/10) are shown apart. */
function summary(m: Omit<TaskRunResult['metrics'], 'resolved'>): string {
  const fresh = m.tokens_in + m.tokens_out;
  const calls = m.requests === undefined ? '' : `, ${String(m.requests)} calls`;
  const outage = m.provider_outage_ms
    ? ` (${(m.provider_outage_ms / 1000).toFixed(0)}s waiting on the provider)`
    : '';
  return `$${m.usd.toFixed(4)}, ${fmtK(fresh)} fresh + ${fmtK(m.cached)} cached tokens${calls}, ${(m.wall_ms / 1000).toFixed(0)}s${outage}`;
}

function makeRunner(name: string, o: RunnerOpts): AgentRunner {
  const make = RUNNERS[name];
  if (!make) fail(`Unknown agent: ${name}`);
  return make(o);
}

/** A positive integer option, or exit with a clear message. */
function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a positive integer, got '${raw}'`);
  return n;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
