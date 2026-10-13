import { program } from 'commander';
import { resolve } from 'node:path';
import { getJimmy10Suite } from './suites/index.ts';
import { OmnexxRunner } from './runners/omnexx.ts';
import { ClaudeCodeRunner } from './runners/claude-code.ts';
import { CodexRunner } from './runners/codex.ts';
import { createResultsWriter } from './results.ts';
import type { BenchConfig, Suite, TaskRunResult } from './types.ts';
import type { AgentRunner } from './runners/base.ts';

const SUITES: Record<string, () => Suite> = {
  jimmy10: getJimmy10Suite,
};

interface RunnerOpts {
  hours: number;
  budget: number;
  model?: string | undefined;
  context: 'lean' | 'full';
}

const RUNNERS: Record<string, (o: RunnerOpts) => AgentRunner> = {
  omnexx: (o) =>
    new OmnexxRunner({ hours: o.hours, budgetUsd: o.budget, model: o.model, context: o.context }),
  'claude-code': () => new ClaudeCodeRunner(),
  codex: () => new CodexRunner(),
};

interface Opts {
  suite: string;
  agents: string;
  out: string;
  task?: string;
  dryRun?: boolean;
  hours: string;
  budget: string;
  model?: string;
  context: string;
}

const ZERO = { usd: 0, tokens_in: 0, tokens_out: 0, cached: 0, wall_ms: 0, interventions: 0 };

async function main(): Promise<void> {
  program
    .name('bench')
    .description('Omnexx benchmark runner')
    .requiredOption('--suite <name>', `suite: ${Object.keys(SUITES).join(' | ')}`)
    .requiredOption('--agents <list>', `comma-separated: ${Object.keys(RUNNERS).join(',')}`)
    .requiredOption('--out <dir>', 'name for this result set: written to bench/results/<name>')
    .option('--task <id>', 'run only this task')
    .option('--hours <n>', 'omnexx wall-clock cap per task', '0.5')
    .option('--budget <usd>', 'omnexx spend cap per task', '2')
    .option('--model <ref>', 'omnexx: one model for every role, e.g. ollama:gpt-oss:120b-cloud')
    .option(
      '--context <mode>',
      'omnexx: lean (0.8 defaults) or full (every section pinned)',
      'lean',
    )
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

  const runners: AgentRunner[] = [];
  for (const name of config.agents) {
    const make = RUNNERS[name];
    if (!make) fail(`Unknown agent: ${name}`);
    if (opts.context !== 'lean' && opts.context !== 'full')
      throw new Error('--context is lean or full');
    const runner = make({
      hours: Number(opts.hours),
      budget: Number(opts.budget),
      model: opts.model,
      context: opts.context,
    });
    if (!(await runner.isAvailable())) console.warn(`Warning: agent '${name}' is not available`);
    runners.push(runner);
  }

  const tasks = (await suite.loadTasks()).filter((t) => !opts.task || t.id === opts.task);
  if (!tasks.length) fail('No tasks to run');

  console.log(`Suite ${config.suite}; agents ${config.agents.join(', ')}; out ${config.out}`);
  console.log(`Tasks: ${tasks.map((t) => t.id).join(', ')}`);
  if (opts.dryRun) return;

  const writer = createResultsWriter(config);
  for (const task of tasks) {
    console.log(`\n=== ${task.id} ===`);
    for (const runner of runners) {
      const workDir = resolve(config.out, 'work', config.suite, task.id, runner.agentName);
      const startedAt = new Date().toISOString();
      let result: TaskRunResult;
      try {
        await suite.setupTask(task, workDir);
        const goal = await suite.getGoal(task);
        // The agent works; the suite's hidden check decides whether it resolved the task.
        const { resultDir, ...metrics } = await runner.run(task, workDir, goal);
        const resolved = await suite.checkTask(task, resultDir ?? workDir);
        result = {
          taskId: task.id,
          suite: config.suite,
          agent: runner.agentName,
          metrics: { ...metrics, resolved },
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        const tok = metrics.tokens_in + metrics.cached + metrics.tokens_out;
        console.log(
          `  ${resolved ? 'PASS' : 'FAIL'} ${runner.agentName}: $${metrics.usd.toFixed(4)}, ${tok} tokens, ${(metrics.wall_ms / 1000).toFixed(0)}s`,
        );
      } catch (error) {
        console.error(`  ERROR ${runner.agentName}: ${String(error)}`);
        result = {
          taskId: task.id,
          suite: config.suite,
          agent: runner.agentName,
          metrics: { ...ZERO, resolved: false },
          startedAt,
          finishedAt: new Date().toISOString(),
          error: String(error),
        };
      }
      await writer.writeResult(result);
    }
  }
  console.log(`\nResults: ${writer.getOutDir()}/${writer.getRunId()}.md`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
