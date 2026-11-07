/**
 * `omnexx review list|approve|reject`: the human verdict on finished daemon tasks.
 * The review queue is `.omnexx/review-queue.json`, written by the shipping controller
 * when a task ships as a Tier 2/3 PR (or a Tier 1 push that needs a human eye).
 * Approve removes the entry — the merge itself is the operator's (the PR or branch
 * is printed); reject removes it, writes a permanent tombstone, and records the
 * reason in learned_patterns so discovery stops proposing the same work.
 */
import pc from 'picocolors';
import { loadConfig } from '../../config/load.js';
import {
  readQueue,
  readReviewQueue,
  rejectTask,
  resolveAutonomousPaths,
  writeReviewQueue,
} from '../../autonomous/state.js';
import { UsageError } from '../../errors.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

async function reviewPaths(io: CliIO) {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  return resolveAutonomousPaths(io.cwd, config.autonomous);
}

export async function reviewList(io: CliIO, json = false): Promise<number> {
  const paths = await reviewPaths(io);
  const entries = readReviewQueue(paths.reviewQueuePath);
  const titles = new Map((await readQueue(paths)).map((t) => [t.id, t.title]));
  if (json) {
    println(
      io.stdout,
      JSON.stringify(
        { tasks: entries.map((e) => ({ ...e, title: titles.get(e.taskId) ?? null })) },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  if (entries.length === 0) {
    println(io.stdout, 'nothing awaiting review');
    return EXIT.ok;
  }
  println(io.stdout, pc.bold(`Awaiting review (${String(entries.length)})`));
  for (const e of entries)
    println(
      io.stdout,
      `  ${e.taskId}  tier ${String(e.tier)} · risk ${String(e.riskScore)}  ${e.branch}${e.prUrl ? `  ${e.prUrl}` : ''}  ${titles.get(e.taskId) ?? ''}`,
    );
  return EXIT.ok;
}

export async function reviewApprove(io: CliIO, taskId: string): Promise<number> {
  const paths = await reviewPaths(io);
  const entries = readReviewQueue(paths.reviewQueuePath);
  const entry = entries.find((e) => e.taskId === taskId);
  if (!entry) throw new UsageError(`no task ${taskId} awaiting review`, 'see `omnexx review list`');
  writeReviewQueue(
    paths.reviewQueuePath,
    entries.filter((e) => e.taskId !== taskId),
  );
  println(io.stdout, `approved ${taskId}`);
  if (entry.prUrl) println(io.stdout, `merge it with: gh pr merge ${entry.prUrl}`);
  else println(io.stdout, `branch ${entry.branch} is ready (no PR was opened for it)`);
  return EXIT.ok;
}

export async function reviewReject(
  io: CliIO,
  taskId: string,
  reason: string | undefined,
): Promise<number> {
  const paths = await reviewPaths(io);
  const text = reason?.trim() ? reason.trim() : 'rejected without a reason';
  if (!(await rejectTask(paths, taskId, text)))
    throw new UsageError(
      `no task ${taskId} awaiting review or in the queue`,
      'see `omnexx review list`',
    );
  println(
    io.stdout,
    `rejected ${taskId} (tombstoned permanently; reason saved to learned_patterns)`,
  );
  return EXIT.ok;
}

export const register: CommandRegistrar = (program, io, setExit) => {
  const review = program.command('review').description('approve or reject finished daemon tasks');
  review
    .command('list')
    .option('--json', 'machine-readable output')
    .description('tasks waiting for a human verdict')
    .action(async (opts: { json?: boolean }) => {
      setExit(await reviewList(io, opts.json === true));
    });
  review
    .command('approve <task-id>')
    .description('approve a task for merge')
    .action(async (taskId: string) => {
      setExit(await reviewApprove(io, taskId));
    });
  review
    .command('reject <task-id>')
    .option('--reason <text>', 'why it was rejected (saved to learned_patterns)')
    .description('reject a task: tombstone it permanently and record the reason')
    .action(async (taskId: string, opts: { reason?: string }) => {
      setExit(await reviewReject(io, taskId, opts.reason));
    });
};
