import { program } from 'commander';
import { getJimmy10Suite, getLite50Suite } from './suites/index.js';
import { OmnexxRunner } from './runners/omnexx.js';
import { ClaudeCodeRunner } from './runners/claude-code.js';
import { CodexRunner } from './runners/codex.js';
import { createResultsWriter } from './results.js';
import type { BenchConfig, TaskDef } from './types.js';
import type { AgentRunner } from './runners/base.js';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SUITES: Record<string, any> = {
  jimmy10: getJimmy10Suite(),
  lite50: getLite50Suite(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RUNNERS: Record<string, () => any> = {
  omnexx: () => new OmnexxRunner(),
  'claude-code': () => new ClaudeCodeRunner(),
  codex: () => new CodexRunner(),
};

async function main(): Promise<void> {
  program
    .name('bench')
    .description('Omnexx benchmark runner')
    .requiredOption('--suite <name>', 'Suite to run: jimmy10 | lite50 | longspec')
    .requiredOption('--agents <list>', 'Comma-separated list of agents: omnexx,claude-code,codex')
    .requiredOption('--out <dir>', 'Output directory for results')
    .option('--task <id>', 'Run only a specific task ID')
    .option('--dry-run', 'Show what would be run without executing')
    .parse();

  const opts = program.opts();

  const config: BenchConfig = {
    suite: opts.suite,
    agents: opts.agents.split(',').map((a: string) => a.trim()),
    out: opts.out,
  };

  // Validate suite
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const suite = SUITES[config.suite];
  if (!suite) {
    console.error(`Unknown suite: ${config.suite}. Available: ${Object.keys(SUITES).join(', ')}`);
    process.exit(1);
  }

  // Validate agents
  const runners: AgentRunner[] = [];
  for (const agentName of config.agents) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const factory = RUNNERS[agentName];
    if (!factory) {
      console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(RUNNERS).join(', ')}`);
      process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const runner = factory();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const available = await runner.isAvailable();
    if (!available) {
      console.warn(
        `Warning: Agent '${agentName}' not available on this system (binary not found or version check failed)`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    runners.push(runner);
  }

  // Load tasks
  const tasks = await suite.loadTasks();
  const filteredTasks = opts.task ? tasks.filter((t: TaskDef) => t.id === opts.task) : tasks;

  if (filteredTasks.length === 0) {
    console.error('No tasks to run');
    process.exit(1);
  }

  console.log(`Running suite: ${config.suite}`);
  console.log(`Agents: ${config.agents.join(', ')}`);
  console.log(`Tasks: ${filteredTasks.map((t: TaskDef) => t.id).join(', ')}`);
  console.log(`Output: ${config.out}`);

  if (opts.dryRun) {
    console.log('DRY RUN - no tasks will be executed');
    return;
  }

  // Create results writer
  const writer = createResultsWriter(config);

  // Run each task with each agent
  for (const task of filteredTasks) {
    console.log(`\n=== Task: ${task.id} ===`);

    for (const runner of runners) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      console.log(`  Running with ${runner.agentName}...`);

      // Create a temporary work directory for this task run
      const workDir = join(config.out, 'work', config.suite, task.id, runner.agentName);

      try {
        // Set up the task
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        await suite.setupTask(task, workDir);

        // Write goal.md for the agent
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const goal = await suite.getGoal(task);
        const fs = await import('node:fs/promises');
        await fs.writeFile(join(workDir, 'goal.md'), goal, 'utf-8');

        // Run the agent
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const metrics = await runner.run(task, workDir);

        // Check the result
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const passed = await suite.checkTask(task, workDir);

        // Create result
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        const result = {
          taskId: task.id,
          suite: config.suite,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          agent: runner.agentName,
          metrics: { ...metrics, resolved: passed },
          startedAt: new Date(Date.now() - metrics.wall_ms).toISOString(),
          finishedAt: new Date().toISOString(),
        };

        await writer.writeResult(result);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions
        console.log(
          `    ${passed ? '✅' : '❌'} ${runner.agentName} - $${metrics.usd.toFixed(4)}, ${(metrics.wall_ms / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions
        console.error(`    ❌ ${runner.agentName} - Error: ${error}`);
        const errorResult = {
          taskId: task.id,
          suite: config.suite,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          agent: runner.agentName,
          metrics: {
            resolved: false,
            usd: 0,
            tokens_in: 0,
            tokens_out: 0,
            cached: 0,
            wall_ms: 0,
            interventions: 0,
          },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: String(error),
        };
        await writer.writeResult(errorResult);
      }
    }
  }

  console.log(`\n✅ Benchmark complete. Results in ${writer.getOutDir()}/${writer.getRunId()}.md`);
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
