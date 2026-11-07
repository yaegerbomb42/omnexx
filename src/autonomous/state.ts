/**
 * The daemon's state surface, read through the state store that owns the schema
 * (`src/autonomous/state-store.ts`, `AutonomousStateStore`) and the review queue the
 * shipping controller owns (`.omnexx/review-queue.json`). The daemon itself
 * (`src/autonomous/daemon.ts`) is the only writer while it runs; the CLI writes only
 * the control file, and `queue drop` / `review approve|reject` — the human's explicit
 * verdicts.
 *
 * Every read tolerates a missing DB, a missing table, or a missing review queue (the
 * daemon may not have created them yet) and reports "nothing there" instead of
 * crashing. `node:sqlite` is dynamically imported (tsup rewrites a static import of
 * the built-in). All writes go through the store; the read-only direct connections
 * below are for views the store has no list API for (tombstones, last activity,
 * burn windows).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AutonomousConfig } from '../config/sections/autonomous.js';
import type {
  AutonomousStateStore,
  QueuedTask as StoreTask,
  TombstoneEntry,
} from './state-store.js';

export interface AutonomousPaths {
  repoRoot: string;
  dbPath: string;
  lockPath: string;
  controlPath: string;
  logPath: string;
  reviewQueuePath: string;
  worktreeDir: string;
}

export function resolveAutonomousPaths(cwd: string, config: AutonomousConfig): AutonomousPaths {
  const dir = join(cwd, '.omnexx');
  return {
    repoRoot: cwd,
    dbPath: join(cwd, config.state_db_path),
    lockPath: join(dir, 'daemon.lock'),
    controlPath: join(dir, 'daemon-control.json'),
    logPath: join(dir, 'logs', 'daemon.log'),
    reviewQueuePath: join(dir, 'review-queue.json'),
    worktreeDir: join(cwd, config.worktree_dir),
  };
}

/** One queued task, with a human-readable title pulled out of its finding payload. */
export interface QueueTaskView {
  id: string;
  fingerprint: string;
  title: string;
  description: string;
  collector: string;
  priorityScore: number;
  status: string;
  targetFiles: string[];
  worktreePath: string | null;
  baseCommitSha: string | null;
  attemptCount: number;
  tokensSpent: number;
  turnsSpent: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TombstoneView {
  fingerprint: string;
  failureStage: string;
  failureReason: string;
  strikeCount: number;
  /** -1 = permanent, otherwise epoch ms when the cooldown expires. */
  cooldownUntilMs: number;
  quarantineGitRef: string | null;
  updatedAtMs: number;
}

export interface ReviewQueueEntry {
  taskId: string;
  tier: 1 | 2 | 3;
  riskScore: number;
  branch: string;
  prUrl?: string | undefined;
  needsHumanApproval: boolean;
  createdAt: number;
}

export interface DaemonLock {
  pid: number;
  host: string;
  bootId: string;
  startedAt: number;
}

export interface LastActivity {
  taskId: string;
  phase: string;
  createdAtMs: number;
}

interface SqliteStatement {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => { changes: number };
}

interface SqliteDb {
  prepare: (sql: string) => SqliteStatement;
  exec: (sql: string) => void;
  close: () => void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    return (await import('node:sqlite')) as SqliteModule;
  } catch {
    return null;
  }
}

async function openStore(paths: AutonomousPaths): Promise<AutonomousStateStore | null> {
  if (!existsSync(paths.dbPath)) return null;
  try {
    const { AutonomousStateStore: Store } = await import('./state-store.js');
    const store = new Store({ repoRoot: paths.repoRoot, dbPath: paths.dbPath });
    await store.open();
    return store;
  } catch {
    return null;
  }
}

function payloadText(payload: unknown, keys: readonly string[]): string {
  if (payload === null || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

export function toQueueTaskView(task: StoreTask): QueueTaskView {
  return {
    id: task.taskId,
    fingerprint: task.fingerprint,
    title:
      payloadText(task.findingPayload, ['title', 'summary', 'message']) ||
      `${task.sourceCollector} finding`,
    description: payloadText(task.findingPayload, ['description', 'detail', 'body']),
    collector: task.sourceCollector,
    priorityScore: task.priorityScore,
    status: task.status,
    targetFiles: task.targetFiles,
    worktreePath: task.worktreePath,
    baseCommitSha: task.baseCommitSha,
    attemptCount: task.attemptCount,
    tokensSpent: task.tokensSpent,
    turnsSpent: task.turnsSpent,
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
  };
}

export async function readQueue(paths: AutonomousPaths): Promise<QueueTaskView[]> {
  const store = await openStore(paths);
  if (!store) return [];
  try {
    return store.listTasks().map(toQueueTaskView);
  } catch {
    return [];
  } finally {
    store.close();
  }
}

export async function findTask(
  paths: AutonomousPaths,
  taskId: string,
): Promise<QueueTaskView | null> {
  const store = await openStore(paths);
  if (!store) return null;
  try {
    const task = store.getTask(taskId);
    return task ? toQueueTaskView(task) : null;
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/** All tombstones, newest first (read-only; the store has no list-all). */
export async function readTombstones(paths: AutonomousPaths): Promise<TombstoneView[]> {
  if (!existsSync(paths.dbPath)) return [];
  const sqlite = await loadSqlite();
  if (!sqlite) return [];
  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(paths.dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT fingerprint, failure_stage, failure_reason, strike_count,
                cooldown_until_ms, quarantine_git_ref, updated_at_ms
         FROM tombstone_registry ORDER BY updated_at_ms DESC`,
      )
      .all();
    return rows.map((r) => ({
      fingerprint: asString(r.fingerprint),
      failureStage: asString(r.failure_stage),
      failureReason: asString(r.failure_reason),
      strikeCount: typeof r.strike_count === 'number' ? r.strike_count : 0,
      cooldownUntilMs: typeof r.cooldown_until_ms === 'number' ? r.cooldown_until_ms : 0,
      quarantineGitRef: typeof r.quarantine_git_ref === 'string' ? r.quarantine_git_ref : null,
      updatedAtMs: typeof r.updated_at_ms === 'number' ? r.updated_at_ms : 0,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** The most recent step-journal entry, if the daemon has done anything yet. */
export async function readLastActivity(paths: AutonomousPaths): Promise<LastActivity | null> {
  if (!existsSync(paths.dbPath)) return null;
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(paths.dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT task_id, phase, created_at_ms FROM step_journal
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get();
    if (!row) return null;
    return {
      taskId: asString(row.task_id),
      phase: asString(row.phase),
      createdAtMs: typeof row.created_at_ms === 'number' ? row.created_at_ms : 0,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Token/cost burn summed from budget_ledger windows that started in the window. */
export async function readBurn(
  paths: AutonomousPaths,
  nowMs: number,
): Promise<{ tokens1h: number; cost1hUsd: number; tokens24h: number; cost24hUsd: number }> {
  const empty = { tokens1h: 0, cost1hUsd: 0, tokens24h: 0, cost24hUsd: 0 };
  if (!existsSync(paths.dbPath)) return empty;
  const sqlite = await loadSqlite();
  if (!sqlite) return empty;
  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(paths.dbPath, { readOnly: true });
    const rows = db
      .prepare(`SELECT tokens_spent, cost_usd, window_start_ms FROM budget_ledger`)
      .all();
    const burn = { ...empty };
    for (const r of rows) {
      const tokens = typeof r.tokens_spent === 'number' ? r.tokens_spent : 0;
      const cost = typeof r.cost_usd === 'number' ? r.cost_usd : 0;
      const start = typeof r.window_start_ms === 'number' ? r.window_start_ms : 0;
      if (start >= nowMs - 24 * 3_600_000) {
        burn.tokens24h += tokens;
        burn.cost24hUsd += cost;
        if (start >= nowMs - 3_600_000) {
          burn.tokens1h += tokens;
          burn.cost1hUsd += cost;
        }
      }
    }
    return burn;
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}

/** The fingerprint for a task id, from the queue or the done set (read-only). */
export async function findFingerprint(
  paths: AutonomousPaths,
  taskId: string,
): Promise<string | null> {
  const store = await openStore(paths);
  if (store) {
    try {
      const task = store.getTask(taskId);
      if (task) return task.fingerprint;
    } catch {
      // Fall through to the done-set lookup below.
    } finally {
      store.close();
    }
  }
  if (!existsSync(paths.dbPath)) return null;
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(paths.dbPath, { readOnly: true });
    const row = db.prepare(`SELECT fingerprint FROM done_set WHERE task_id = ?`).get(taskId);
    return row && typeof row.fingerprint === 'string' ? row.fingerprint : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The daemon's lock (`.omnexx/daemon.lock`), or null when no daemon holds it. */
export function readDaemonLock(lockPath: string): DaemonLock | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const lock = parsed as Record<string, unknown>;
    const pid = lock.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch {
      return null;
    }
    return {
      pid,
      host: typeof lock.host === 'string' ? lock.host : '',
      bootId: typeof lock.bootId === 'string' ? lock.bootId : '',
      startedAt: typeof lock.startedAt === 'number' ? lock.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export type DaemonControlAction = 'pause' | 'resume' | 'stop';

/**
 * Tell a running daemon what to do. The daemon has no control-file polling yet, so
 * pause/resume/stop also act on the process directly (SIGSTOP/SIGCONT/SIGTERM);
 * the file is the durable record for the polling the daemon worker adds later.
 */
export function writeDaemonControl(
  controlPath: string,
  action: DaemonControlAction,
  taskId?: string,
): void {
  mkdirSync(dirname(controlPath), { recursive: true });
  writeFileSync(
    controlPath,
    JSON.stringify(
      {
        action,
        ...(taskId ? { task_id: taskId } : {}),
        at: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
}

/** Last `lines` lines of the daemon log, or null when the daemon has never logged. */
export function readLogTail(logPath: string, lines: number): string[] | null {
  if (!existsSync(logPath)) return null;
  const text = readFileSync(logPath, 'utf8');
  const all = text.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.slice(-Math.max(1, lines));
}

export function readReviewQueue(reviewQueuePath: string): ReviewQueueEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(reviewQueuePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return (parsed as Record<string, unknown>[])
      .filter((e) => typeof e.taskId === 'string')
      .map((e) => ({
        taskId: e.taskId as string,
        tier: e.tier === 1 || e.tier === 2 || e.tier === 3 ? e.tier : 2,
        riskScore: typeof e.riskScore === 'number' ? e.riskScore : 0,
        branch: typeof e.branch === 'string' ? e.branch : '',
        ...(typeof e.prUrl === 'string' ? { prUrl: e.prUrl } : {}),
        needsHumanApproval: e.needsHumanApproval === true,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      }));
  } catch {
    return [];
  }
}

export function writeReviewQueue(reviewQueuePath: string, entries: ReviewQueueEntry[]): void {
  mkdirSync(dirname(reviewQueuePath), { recursive: true });
  const tmp = `${reviewQueuePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n');
  renameSync(tmp, reviewQueuePath);
}

/**
 * Remove a task from the queue. The store has no delete API, so this is the one
 * direct write: a short-lived connection, busy_timeout set so a running daemon's
 * open connection does not make it fail. False when the DB or the task is missing.
 */
export async function dropTask(paths: AutonomousPaths, taskId: string): Promise<boolean> {
  const store = await openStore(paths);
  if (!store) return false;
  try {
    return store.deleteTask(taskId);
  } catch {
    return false;
  } finally {
    store.close();
  }
}

/**
 * Reject a task: it leaves the review queue (and the work queue, if still there), a
 * permanent tombstone (cooldown -1) records the verdict, and the reason is written
 * to learned_patterns as an anti-pattern so discovery stops proposing the same work.
 * The store's tombstone() computes a strike cooldown, so permanence is stamped with
 * the one direct write afterwards.
 */
export async function rejectTask(
  paths: AutonomousPaths,
  taskId: string,
  reason: string,
): Promise<boolean> {
  const fingerprint = await findFingerprint(paths, taskId);
  const before = readReviewQueue(paths.reviewQueuePath);
  const inReview = before.some((e) => e.taskId === taskId);
  if (!inReview && !fingerprint) return false;

  // Persist store-side effects first so a failure leaves the review queue intact.
  if (fingerprint) {
    const store = await openStore(paths);
    if (!store) return inReview;
    try {
      const existing: TombstoneEntry | null = store.getTombstone(fingerprint);
      store.tombstone({
        taskId,
        fingerprint,
        failure: {
          failureStage: 'REVIEW_REJECTED',
          failureReason: reason,
          ...(existing?.lastDiffHash ? { lastDiffHash: existing.lastDiffHash } : {}),
          targetBlobHashes: existing?.targetBlobHashes ?? {},
          ...(existing?.quarantineGitRef ? { quarantineGitRef: existing.quarantineGitRef } : {}),
        },
      });
      store.recordPattern({
        scopeGlob: '**',
        patternType: 'ANTI_PATTERN',
        ruleSummary: `rejected in review (${taskId}): ${reason}`,
        confidence: 0.9,
        createdFromTaskId: taskId,
      });
    } catch {
      return inReview;
    } finally {
      store.close();
    }
    const store2 = await openStore(paths);
    if (store2) {
      try {
        store2.makeTombstonePermanent(fingerprint);
      } catch {
        // The tombstone and pattern are recorded; only the permanence stamp failed.
      } finally {
        store2.close();
      }
    }
  }

  writeReviewQueue(
    paths.reviewQueuePath,
    before.filter((e) => e.taskId !== taskId),
  );
  return true;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err instanceof Error ? err : new Error('git failed'));
      else resolve(stdout);
    });
  });
}

/**
 * The diff for a task, for review: the shipped branch against its merge-base with
 * the base branch, or the worktree's committed + uncommitted diff for a queued task.
 * Null when there is nothing to show yet.
 */
export async function getTaskDiff(
  cwd: string,
  baseBranch: string,
  task: QueueTaskView,
  reviewEntry: ReviewQueueEntry | null,
): Promise<string | null> {
  try {
    if (reviewEntry?.branch) {
      const mergeBase = (await runGit(['merge-base', baseBranch, reviewEntry.branch], cwd)).trim();
      if (!mergeBase) return null;
      return await runGit(['diff', mergeBase, reviewEntry.branch], cwd);
    }
    if (task.worktreePath && task.baseCommitSha) {
      const committed = await runGit(['diff', task.baseCommitSha, 'HEAD'], task.worktreePath).catch(
        () => '',
      );
      const uncommitted = await runGit(['diff'], task.worktreePath).catch(() => '');
      const diff = [committed.trim(), uncommitted.trim()].filter(Boolean).join('\\n');
      return diff === '' ? null : diff;
    }
    return null;
  } catch {
    return null;
  }
}
