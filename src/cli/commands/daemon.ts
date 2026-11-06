/**
 * `omnexx daemon start|stop|status|pause|resume|logs`: the 24/7 autonomous daemon.
 *
 * `start` wires the real `AutonomousDaemon` (`src/autonomous/daemon.ts`) with an
 * `AutonomousStateStore`, the limits from `[autonomous]`, and every collaborator
 * the daemon accepts — discovery, triage, planner, executor, verifier, shipper,
 * worktrees, quality ratchet and the budget gate — via `buildDaemonCollaborators`
 * below, so a queued task flows discover → plan → implement → verify → ship.
 * `status`/`logs`/`pause`/`resume`/`stop` work off the daemon lock
 * (`.omnexx/daemon.lock`), the state DB and the control file, so they are honest
 * about a daemon that is not running.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { buildDaemonBudgetGate, createUsageRecorder } from '../../autonomous/budget-gate.js';
import type { DaemonUsageRecorder } from '../../autonomous/budget-gate.js';
import type {
  ArchitectPlanner,
  BudgetGate,
  DaemonLogger,
  TaskExecutor,
} from '../../autonomous/daemon.js';
import { ALL_COLLECTORS, DiscoveryOrchestrator } from '../../autonomous/discovery/index.js';
import { createTaskExecutor } from '../../autonomous/executor.js';
import { createArchitectPlanner } from '../../autonomous/planner.js';
import { QualityRatchet } from '../../autonomous/quality-ratchet.js';
import { ShippingController } from '../../autonomous/shipping.js';
import type { AutonomousStateStore } from '../../autonomous/state-store.js';
import { TriageEngine } from '../../autonomous/triage.js';
import { VerificationPipeline } from '../../autonomous/verification-pipeline.js';
import { WorktreeManager } from '../../autonomous/worktree-manager.js';
import type { BudgetLedger, DaemonBudgetGovernor } from '../../core/budgetGovernor.js';
import type { OmnexxConfig } from '../../config/schema.js';
import type { AutonomousCollector } from '../../config/sections/autonomous.js';
import { describeError, UsageError } from '../../errors.js';
import type { Provider } from '../../providers/types.js';
import { loadConfig } from '../../config/load.js';
import { resolveRunDeps } from '../run-deps.js';
import {
  findTask,
  getTaskDiff,
  readBurn,
  readDaemonLock,
  readLastActivity,
  readLogTail,
  readQueue,
  readReviewQueue,
  resolveAutonomousPaths,
  writeDaemonControl,
  type AutonomousPaths,
} from '../../autonomous/state.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

async function autonomousPaths(io: CliIO) {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  return { config, paths: resolveAutonomousPaths(io.cwd, config.autonomous) };
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err instanceof Error ? err : new Error('git failed'));
      else resolve(stdout);
    });
  });
}

export async function daemonStatus(io: CliIO, json = false): Promise<number> {
  const { config, paths } = await autonomousPaths(io);
  const now = Date.now();
  const lock = readDaemonLock(paths.lockPath);
  const queue = await readQueue(paths);
  const review = readReviewQueue(paths.reviewQueuePath);
  const burn = await readBurn(paths, now);
  const last = await readLastActivity(paths);
  const active = last ? await findTask(paths, last.taskId) : null;
  const data = {
    running: lock !== null,
    ...(lock ? { pid: lock.pid, started_at: new Date(lock.startedAt).toISOString() } : {}),
    enabled: config.autonomous.enabled,
    mode: config.autonomous.mode,
    target_branch: config.autonomous.target_branch,
    base_branch: config.autonomous.base_branch,
    state_db: existsSync(paths.dbPath) ? paths.dbPath : null,
    active_task:
      lock !== null && active && ['PLANNING', 'IMPLEMENTING', 'VERIFYING'].includes(active.status)
        ? { id: active.id, title: active.title, status: active.status }
        : null,
    last_activity: last
      ? { task_id: last.taskId, phase: last.phase, at: new Date(last.createdAtMs).toISOString() }
      : null,
    queue_depth: queue.filter((t) => t.status === 'QUEUED').length,
    review_pending: review.length,
    tokens_1h: burn.tokens1h,
    tokens_24h: burn.tokens24h,
    cost_1h_usd: burn.cost1hUsd,
    cost_24h_usd: burn.cost24hUsd,
    // Ratchet health is not persisted anywhere yet; the quality ratchet measures
    // the live worktree, so there is nothing to report while the daemon is down.
    ratchet_health: null as string | null,
  };
  if (json) {
    println(io.stdout, JSON.stringify(data, null, 2));
    return EXIT.ok;
  }
  println(io.stdout, pc.bold('Autonomous daemon'));
  println(
    io.stdout,
    `  status  ${data.running ? pc.green(`running (pid ${String(lock?.pid)})`) : pc.yellow('not running')}${config.autonomous.enabled ? '' : pc.dim(' · disabled in omnexx.toml')}`,
  );
  println(io.stdout, `  mode    ${data.mode} · ${data.base_branch} → ${data.target_branch}`);
  println(
    io.stdout,
    `  active  ${data.active_task ? `${data.active_task.id} — ${data.active_task.title}` : 'none'}`,
  );
  println(
    io.stdout,
    `  queue   ${String(data.queue_depth)} queued · ${String(data.review_pending)} awaiting review`,
  );
  const burnLine = (tokens: number, cost: number): string =>
    `${tokens.toLocaleString()} tokens · $${cost.toFixed(2)}`;
  println(io.stdout, `  burn 1h ${burnLine(data.tokens_1h, data.cost_1h_usd)}`);
  println(io.stdout, `  burn 24h ${burnLine(data.tokens_24h, data.cost_24h_usd)}`);
  println(io.stdout, `  ratchet ${data.ratchet_health ?? 'unknown'}`);
  if (!existsSync(paths.dbPath))
    println(io.stdout, pc.dim(`  no state DB yet at ${paths.dbPath} (start the daemon first)`));
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Collaborator wiring (the daemon's discover → plan → implement → verify →
// ship pipeline). `daemonStart` calls `buildDaemonCollaborators` once; the
// --detach path re-execs into `daemonStart`, so both paths get the same wiring.
// ---------------------------------------------------------------------------

/**
 * The planner / executor factories' contract (`src/autonomous/planner.ts` and
 * `src/autonomous/executor.ts`):
 * - `createArchitectPlanner({ provider, config, logger?, onUsage? }): LlmArchitectPlanner`
 * - `createTaskExecutor({ provider, config, repoRoot, logger?, onUsage? }): AgentTaskExecutor`
 * Both factories are injectable so tests can stub them without a model key.
 * `onUsage` is the budget recorder (`createUsageRecorder` in
 * `src/autonomous/budget-gate.ts`): every priced model call is written to the
 * budget ledger, so the gate's caps actually see the daemon's spend.
 */
export type PlannerFactory = (opts: {
  provider: Provider;
  config: OmnexxConfig;
  logger?: DaemonLogger;
  onUsage?: DaemonUsageRecorder;
}) => ArchitectPlanner | Promise<ArchitectPlanner>;

export type ExecutorFactory = (opts: {
  provider: Provider;
  config: OmnexxConfig;
  repoRoot: string;
  logger?: DaemonLogger;
  onUsage?: DaemonUsageRecorder;
}) => TaskExecutor | Promise<TaskExecutor>;

export interface DaemonCollaborators {
  discovery: DiscoveryOrchestrator;
  triage: TriageEngine;
  planner: ArchitectPlanner;
  executor: TaskExecutor;
  verifier: VerificationPipeline;
  shipper: ShippingController;
  worktrees: WorktreeManager;
  qualityRatchet: QualityRatchet;
  budget: BudgetGate;
  governor: DaemonBudgetGovernor;
}

export interface BuildDaemonCollaboratorsOptions {
  repoRoot: string;
  config: OmnexxConfig;
  paths: AutonomousPaths;
  store: AutonomousStateStore;
  provider: Provider;
  /** `--max-cost-day` override, already parsed to USD. */
  maxCostDayUsd?: number;
  /** `--target-branch` override; defaults to `config.autonomous.target_branch`. */
  targetBranch?: string;
  /** Test seam: supply the budget ledger instead of the JSON file. */
  ledger?: BudgetLedger;
  plannerFactory?: PlannerFactory;
  executorFactory?: ExecutorFactory;
  logger?: DaemonLogger;
}

/**
 * Construct every collaborator `AutonomousDaemon` accepts, from config and an
 * already-resolved provider.
 */
export async function buildDaemonCollaborators(
  options: BuildDaemonCollaboratorsOptions,
): Promise<DaemonCollaborators> {
  const { repoRoot, config, paths, store, provider } = options;
  const logger = options.logger;
  const targetBranch = options.targetBranch ?? config.autonomous.target_branch;

  // Budget gate first: the planner/executor need the usage recorder, which
  // writes every priced model call into the gate's ledger. Without it the
  // gate reads an empty ledger and the caps can never trip.
  const {
    gate: budget,
    governor,
    ledger,
  } = buildDaemonBudgetGate({
    repoRoot,
    budget: config.autonomous.budget,
    ...(options.maxCostDayUsd !== undefined ? { maxCostDayUsd: options.maxCostDayUsd } : {}),
    ...(options.ledger ? { ledger: options.ledger } : {}),
  });
  const onUsage = createUsageRecorder(ledger);

  // LLM-backed pieces first: fail fast here, before boot-pruning worktrees.
  const planner = await (options.plannerFactory ?? createArchitectPlanner)({
    provider,
    config,
    ...(logger ? { logger } : {}),
    onUsage,
  });
  const executor = await (options.executorFactory ?? createTaskExecutor)({
    provider,
    config,
    repoRoot,
    ...(logger ? { logger } : {}),
    onUsage,
  });

  const enabledCollectors = new Set(config.autonomous.discovery.collectors_enabled);
  const discovery = new DiscoveryOrchestrator(
    ALL_COLLECTORS.filter((c) => enabledCollectors.has(c.name as AutonomousCollector)),
  );
  const triage = new TriageEngine(store, {
    repoRoot,
    minAdmissionScore: config.autonomous.discovery.min_priority_score,
  });
  const verifier = new VerificationPipeline();
  const shipper = new ShippingController({
    repoRoot,
    targetBranch,
    reviewQueuePath: paths.reviewQueuePath,
  });
  const worktrees = await WorktreeManager.boot({ repoRoot });
  const qualityRatchet = new QualityRatchet();

  return {
    discovery,
    triage,
    planner,
    executor,
    verifier,
    shipper,
    worktrees,
    qualityRatchet,
    budget,
    governor,
  };
}

export async function daemonStart(
  io: CliIO,
  opts: { detach?: boolean; maxCostDay?: string; targetBranch?: string },
): Promise<number> {
  const { config, paths } = await autonomousPaths(io);
  if (!config.autonomous.enabled) {
    println(
      io.stderr,
      pc.yellow('autonomous is disabled: set [autonomous] enabled = true in omnexx.toml'),
    );
    return EXIT.error;
  }
  let maxCostDayUsd: number | undefined;
  if (opts.maxCostDay !== undefined) {
    maxCostDayUsd = Number(opts.maxCostDay);
    if (!Number.isFinite(maxCostDayUsd) || maxCostDayUsd <= 0) {
      println(
        io.stderr,
        pc.red(`--max-cost-day must be a positive number of USD (got ${opts.maxCostDay})`),
      );
      return EXIT.error;
    }
  }
  const targetBranch = opts.targetBranch ?? config.autonomous.target_branch;
  if (opts.detach) {
    const entry = io.entry ?? (process.argv[1] ? [process.argv[1]] : []);
    if (entry.length === 0) {
      println(io.stderr, pc.red('cannot detach: no CLI entry point known'));
      return EXIT.error;
    }
    mkdirSync(dirname(paths.logPath), { recursive: true });
    const logFd = openSync(paths.logPath, 'a');
    const args = [...entry, 'daemon', 'start'];
    if (opts.maxCostDay) args.push('--max-cost-day', opts.maxCostDay);
    if (opts.targetBranch) args.push('--target-branch', opts.targetBranch);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: io.cwd,
      env: io.env,
    });
    child.unref();
    println(io.stdout, `daemon started detached (pid ${String(child.pid ?? '?')})`);
    println(io.stdout, `logs: ${paths.logPath}`);
    return EXIT.ok;
  }
  // Foreground: resolve the model provider first. A daemon with no key would
  // fail every queued task closed, so refuse to start instead.
  let resolved: Awaited<ReturnType<typeof resolveRunDeps>>;
  try {
    resolved = await resolveRunDeps(io, io.cwd);
  } catch (err) {
    if (err instanceof UsageError && /api key/i.test(err.message)) {
      println(
        io.stderr,
        pc.red(
          'daemon needs a model key: set ANTHROPIC_API_KEY or run `omnexx auth set anthropic`',
        ),
      );
    } else {
      println(io.stderr, pc.red(describeError(err)));
    }
    return EXIT.error;
  }
  const { AutonomousStateStore } = await import('../../autonomous/state-store.js');
  const { AutonomousDaemon } = await import('../../autonomous/daemon.js');
  const store = new AutonomousStateStore({ repoRoot: io.cwd, dbPath: paths.dbPath });
  await store.open();
  let collaborators: DaemonCollaborators;
  try {
    collaborators = await buildDaemonCollaborators({
      repoRoot: io.cwd,
      config: resolved.config,
      paths,
      store,
      provider: resolved.deps.provider,
      ...(maxCostDayUsd !== undefined ? { maxCostDayUsd } : {}),
      targetBranch,
    });
  } catch (err) {
    println(io.stderr, pc.red(describeError(err)));
    store.close();
    return EXIT.error;
  }
  const daemon = new AutonomousDaemon({
    repoRoot: io.cwd,
    store,
    controlPath: paths.controlPath,
    discovery: collaborators.discovery,
    triage: collaborators.triage,
    planner: collaborators.planner,
    executor: collaborators.executor,
    verifier: collaborators.verifier,
    shipper: collaborators.shipper,
    worktrees: collaborators.worktrees,
    qualityRatchet: collaborators.qualityRatchet,
    budget: collaborators.budget,
    maxTurnsPerTask: config.autonomous.circuit_breakers.max_turns_per_task,
    idleSleepBaseMs: config.autonomous.discovery.interval_sec * 1000,
    idleSleepMaxMs: config.autonomous.discovery.max_backoff_sec * 1000,
    watchdogStallMs: config.autonomous.circuit_breakers.watchdog_stall_timeout_sec * 1000,
  });
  println(
    io.stdout,
    `daemon starting (target ${targetBranch}; discovery/planner/executor/verifier/shipper/worktrees/ratchet/budget wired${maxCostDayUsd !== undefined ? `; day cap $${maxCostDayUsd}` : ''})`,
  );
  await daemon.start();
  return EXIT.ok;
}

export async function daemonPause(io: CliIO): Promise<number> {
  const { paths } = await autonomousPaths(io);
  const lock = readDaemonLock(paths.lockPath);
  if (lock === null) {
    println(io.stderr, pc.yellow('daemon is not running'));
    return EXIT.error;
  }
  const last = await readLastActivity(paths);
  const active = last ? await findTask(paths, last.taskId) : null;
  const activeTask =
    active && ['PLANNING', 'IMPLEMENTING', 'VERIFYING'].includes(active.status) ? active : null;
  writeDaemonControl(paths.controlPath, 'pause', activeTask?.id);
  // Freeze the process now, and checkpoint the active task's worktree HEAD so the
  // work survives a crash: refs/omnexx/wip/<task-id>.
  try {
    process.kill(lock.pid, 'SIGSTOP');
  } catch {
    println(io.stderr, pc.yellow(`could not SIGSTOP pid ${String(lock.pid)}`));
  }
  if (activeTask?.worktreePath) {
    try {
      const head = (await runGit(['rev-parse', 'HEAD'], activeTask.worktreePath)).trim();
      await runGit(['update-ref', `refs/omnexx/wip/${activeTask.id}`, head], io.cwd);
      println(io.stdout, `checkpointed ${activeTask.id} to refs/omnexx/wip/${activeTask.id}`);
    } catch {
      println(io.stdout, pc.yellow(`could not checkpoint ${activeTask.id} (no worktree HEAD)`));
    }
  } else if (activeTask) {
    println(io.stdout, `active task ${activeTask.id} has no worktree to checkpoint`);
  } else {
    println(io.stdout, 'no active task to checkpoint');
  }
  println(io.stdout, 'daemon paused (SIGSTOP; resume with `omnexx daemon resume`)');
  return EXIT.ok;
}

export async function daemonResume(io: CliIO): Promise<number> {
  const { paths } = await autonomousPaths(io);
  const lock = readDaemonLock(paths.lockPath);
  writeDaemonControl(paths.controlPath, 'resume');
  if (lock !== null) {
    try {
      process.kill(lock.pid, 'SIGCONT');
    } catch {
      println(io.stderr, pc.yellow(`could not SIGCONT pid ${String(lock.pid)}`));
    }
  }
  println(io.stdout, 'resume requested');
  return EXIT.ok;
}

export async function daemonStop(io: CliIO): Promise<number> {
  const { paths } = await autonomousPaths(io);
  const lock = readDaemonLock(paths.lockPath);
  writeDaemonControl(paths.controlPath, 'stop');
  if (lock !== null) {
    try {
      process.kill(lock.pid, 'SIGTERM');
      println(io.stdout, `stop requested (SIGTERM to pid ${String(lock.pid)})`);
    } catch {
      println(io.stdout, 'stop requested (daemon pid already gone)');
    }
  } else {
    println(io.stdout, 'stop requested (daemon was not running)');
  }
  return EXIT.ok;
}

export async function daemonLogs(io: CliIO, lines = 50): Promise<number> {
  const { paths } = await autonomousPaths(io);
  const tail = readLogTail(paths.logPath, lines);
  if (tail === null) {
    println(io.stdout, `no daemon log yet at ${paths.logPath}`);
    return EXIT.ok;
  }
  for (const line of tail) println(io.stdout, line);
  return EXIT.ok;
}

/** The diff of a task for `queue inspect` (exported for the VS Code provider). */
export async function inspectTaskDiff(
  io: CliIO,
  paths: AutonomousPaths,
  taskId: string,
): Promise<string | null> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const task = await findTask(paths, taskId);
  if (!task) return null;
  const review = readReviewQueue(paths.reviewQueuePath).find((e) => e.taskId === taskId) ?? null;
  return getTaskDiff(io.cwd, config.autonomous.base_branch, task, review);
}

export const register: CommandRegistrar = (program, io, setExit) => {
  const daemon = program.command('daemon').description('the 24/7 autonomous daemon');
  daemon
    .command('start')
    .option('--detach', 'run the daemon in the background and return')
    .option('--max-cost-day <usd>', 'override [autonomous.budget] max_cost_usd_per_day')
    .option('--target-branch <branch>', 'override [autonomous] target_branch')
    .description('start the daemon (foreground unless --detach)')
    .action(async (opts: { detach?: boolean; maxCostDay?: string; targetBranch?: string }) => {
      setExit(await daemonStart(io, opts));
    });
  daemon
    .command('status')
    .option('--json', 'machine-readable output')
    .description('daemon state, active task, queue depth, token burn, ratchet health')
    .action(async (opts: { json?: boolean }) => {
      setExit(await daemonStatus(io, opts.json === true));
    });
  daemon
    .command('pause')
    .description('pause at the next turn boundary (checkpoints the active task)')
    .action(async () => {
      setExit(await daemonPause(io));
    });
  daemon
    .command('resume')
    .description('resume a paused daemon')
    .action(async () => {
      setExit(await daemonResume(io));
    });
  daemon
    .command('stop')
    .description('stop the daemon')
    .action(async () => {
      setExit(await daemonStop(io));
    });
  daemon
    .command('logs')
    .option('-n, --lines <n>', 'lines to show', '50')
    .description('tail the daemon log (.omnexx/logs/daemon.log)')
    .action(async (opts: { lines?: string }) => {
      const n = Number(opts.lines ?? '50');
      setExit(await daemonLogs(io, Number.isFinite(n) && n > 0 ? Math.floor(n) : 50));
    });
};
