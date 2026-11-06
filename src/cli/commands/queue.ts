/**
 * `omnexx queue list|inspect|drop`: the daemon's work queue, ranked by priority score.
 * Reads the state DB through the state store; with no DB yet the queue is simply empty.
 */
import pc from 'picocolors';
import { loadConfig } from '../../config/load.js';
import {
  dropTask,
  findTask,
  getTaskDiff,
  readQueue,
  readReviewQueue,
  readTombstones,
  resolveAutonomousPaths,
} from '../../autonomous/state.js';
import { UsageError } from '../../errors.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

async function queuePaths(io: CliIO) {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  return { config, paths: resolveAutonomousPaths(io.cwd, config.autonomous) };
}

export async function queueList(
  io: CliIO,
  opts: { includeTombstones?: boolean; json?: boolean } = {},
): Promise<number> {
  const { paths } = await queuePaths(io);
  const tasks = await readQueue(paths);
  const tombstones = opts.includeTombstones ? await readTombstones(paths) : [];
  if (opts.json) {
    println(
      io.stdout,
      JSON.stringify({ tasks, ...(opts.includeTombstones ? { tombstones } : {}) }, null, 2),
    );
    return EXIT.ok;
  }
  if (tasks.length === 0) {
    println(io.stdout, 'queue is empty');
  } else {
    println(io.stdout, pc.bold(`Work queue (${String(tasks.length)})`));
    for (const t of tasks)
      println(
        io.stdout,
        `  ${t.id}  ${t.priorityScore.toFixed(1).padStart(6)}  ${pc.cyan(t.status.padEnd(11))} ${t.collector}  ${t.title}`,
      );
  }
  if (opts.includeTombstones) {
    if (tombstones.length === 0) println(io.stdout, 'no tombstones');
    else {
      println(io.stdout, pc.bold(`Tombstones (${String(tombstones.length)})`));
      for (const t of tombstones)
        println(
          io.stdout,
          `  ${t.fingerprint}  ${t.failureStage} · strikes ${String(t.strikeCount)}${t.cooldownUntilMs === -1 ? ' · permanent' : ` · until ${new Date(t.cooldownUntilMs).toISOString()}`}  ${t.failureReason}`,
        );
    }
  }
  return EXIT.ok;
}

export async function queueInspect(io: CliIO, taskId: string, json = false): Promise<number> {
  const { config, paths } = await queuePaths(io);
  const task = await findTask(paths, taskId);
  if (!task) throw new UsageError(`no queued task ${taskId}`, 'see `omnexx queue list`');
  const review = readReviewQueue(paths.reviewQueuePath).find((e) => e.taskId === taskId) ?? null;
  const diff = await getTaskDiff(io.cwd, config.autonomous.base_branch, task, review);
  if (json) {
    println(io.stdout, JSON.stringify({ ...task, diff }, null, 2));
    return EXIT.ok;
  }
  println(io.stdout, pc.bold(task.id));
  println(io.stdout, `  title     ${task.title}`);
  println(io.stdout, `  status    ${task.status}`);
  println(io.stdout, `  collector ${task.collector} · priority ${task.priorityScore.toFixed(1)}`);
  println(io.stdout, `  files     ${task.targetFiles.join(', ') || '(none)'}`);
  if (task.worktreePath) println(io.stdout, `  worktree  ${task.worktreePath}`);
  println(
    io.stdout,
    `  attempts  ${String(task.attemptCount)} · ${String(task.tokensSpent)} tokens · ${String(task.turnsSpent)} turns`,
  );
  if (review)
    println(
      io.stdout,
      `  review    tier ${String(review.tier)} · risk ${String(review.riskScore)} · ${review.branch}${review.prUrl ? ` · ${review.prUrl}` : ''}`,
    );
  if (task.description) println(io.stdout, `  ${task.description}`);
  if (diff) {
    println(io.stdout, '  --- diff ---');
    println(io.stdout, diff);
  }
  return EXIT.ok;
}

export async function queueDrop(io: CliIO, taskId: string): Promise<number> {
  const { paths } = await queuePaths(io);
  if (!(await dropTask(paths, taskId)))
    throw new UsageError(`no queued task ${taskId}`, 'see `omnexx queue list`');
  println(io.stdout, `dropped ${taskId} from the queue`);
  return EXIT.ok;
}

export const register: CommandRegistrar = (program, io, setExit) => {
  const queue = program.command('queue').description("the daemon's work queue");
  queue
    .command('list')
    .option('--include-tombstones', 'also list tombstoned tasks')
    .option('--json', 'machine-readable output')
    .description('ranked work queue, highest priority first')
    .action(async (opts: { includeTombstones?: boolean; json?: boolean }) => {
      setExit(await queueList(io, opts));
    });
  queue
    .command('inspect <task-id>')
    .option('--json', 'machine-readable output')
    .description('one queued task, with its diff when it has one')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      setExit(await queueInspect(io, taskId, opts.json === true));
    });
  queue
    .command('drop <task-id>')
    .description('remove a task from the queue')
    .action(async (taskId: string) => {
      setExit(await queueDrop(io, taskId));
    });
};
