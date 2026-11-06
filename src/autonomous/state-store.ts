/**
 * SQLite state store for the autonomous daemon.
 *
 * Single source of truth for what the daemon has done, is doing, and refuses
 * to retry. Lives at `.omnexx/autonomous.db` (WAL mode) inside the target
 * repo so state travels with the checkout, and mirrors completion receipts
 * into git notes (`refs/notes/omnexx-auto`) so a fresh clone can hydrate
 * the done-set / tombstone registry without the database file.
 *
 * `node:sqlite` is imported dynamically at runtime (same pattern as
 * `src/tools/query-artifact.ts`) so tsup does not rewrite the built-in
 * module specifier. Node >= 22.5 is required.
 */
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { git } from '../git/git.js';
import { blobsChanged } from './fingerprint.js';

export const AUTONOMOUS_DB_REL_PATH = '.omnexx/autonomous.db';
export const GIT_NOTES_REF = 'refs/notes/omnexx-auto';

/** Cooldown after each tombstone strike (index = strike - 1). */
export const TOMBSTONE_COOLDOWNS_MS: readonly number[] = [
  60 * 60 * 1000, // strike 1: 1h
  6 * 60 * 60 * 1000, // strike 2: 6h
  24 * 60 * 60 * 1000, // strike 3: 24h
  7 * 24 * 60 * 60 * 1000, // strike 4: 7d
];
/** Strike count at which a tombstone becomes permanent (cooldown -1). */
export const MAX_STRIKES_BEFORE_PERMANENT = 5;

export type TaskStatus = 'QUEUED' | 'PLANNING' | 'IMPLEMENTING' | 'VERIFYING' | 'PAUSED_BUDGET';

export type PatternType = 'INVARIANT' | 'ANTI_PATTERN' | 'TOOL_HINT';
export type ReceiptStatus = 'done' | 'tombstoned' | 'queued';

export interface QueuedTask {
  taskId: string;
  fingerprint: string;
  sourceCollector: string;
  priorityScore: number;
  status: TaskStatus;
  targetFiles: string[];
  findingPayload: unknown;
  plan: unknown;
  worktreePath: string | null;
  baseCommitSha: string | null;
  attemptCount: number;
  tokensSpent: number;
  turnsSpent: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DoneEntry {
  fingerprint: string;
  taskId: string;
  sourceCollector: string;
  baseCommitSha: string | null;
  shippedCommitSha: string | null;
  targetBlobHashes: Record<string, string>;
  deliveryMode: string;
  completedAtMs: number;
}

export interface TombstoneEntry {
  fingerprint: string;
  failureStage: string;
  failureReason: string;
  lastDiffHash: string | null;
  targetBlobHashes: Record<string, string>;
  strikeCount: number;
  /** -1 = permanent, otherwise epoch ms when the cooldown expires. */
  cooldownUntilMs: number;
  quarantineGitRef: string | null;
  updatedAtMs: number;
}

export interface StepRecord {
  taskId: string;
  stepIndex: number;
  phase: string;
  toolName: string | null;
  toolArgsHash: string | null;
  gitTreeHash: string | null;
  errorSignature: string | null;
  tokensDelta: number;
  createdAtMs: number;
}

export interface LearnedPattern {
  patternId: string;
  scopeGlob: string;
  patternType: PatternType;
  ruleSummary: string;
  confidence: number;
  createdFromTaskId: string | null;
  createdAtMs: number;
}

export interface FlakyTest {
  testId: string;
  flakeRate: number;
  quarantinedAtMs: number | null;
  remediationTaskId: string | null;
}

export interface BudgetWindow {
  windowKey: string;
  tokensSpent: number;
  costUsd: number;
  windowStartMs: number;
}

export interface DiscardedFinding {
  fingerprint: string;
  sourceCollector: string;
  priorityScore: number;
  reason: string;
  findingPayload: unknown;
  discardedAtMs: number;
}

export interface EnqueueTaskInput {
  fingerprint: string;
  sourceCollector: string;
  priorityScore: number;
  targetFiles: readonly string[];
  findingPayload: unknown;
  baseCommitSha?: string;
}

export interface TaskPatch {
  plan?: unknown;
  worktreePath?: string | null;
  baseCommitSha?: string | null;
  attemptCount?: number;
  tokensSpent?: number;
  turnsSpent?: number;
}

export interface TombstoneFailure {
  failureStage: string;
  failureReason: string;
  lastDiffHash?: string;
  targetBlobHashes: Record<string, string>;
  quarantineGitRef?: string;
}

export interface ReceiptExtra {
  sourceCollector?: string;
  baseCommitSha?: string | null;
  shippedCommitSha?: string | null;
  targetBlobHashes?: Record<string, string>;
  deliveryMode?: string;
  failureStage?: string;
  failureReason?: string;
  strikeCount?: number;
  cooldownUntilMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_queue (
  task_id TEXT PRIMARY KEY,
  fingerprint TEXT UNIQUE NOT NULL,
  source_collector TEXT NOT NULL,
  priority_score REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PLANNING','IMPLEMENTING','VERIFYING','PAUSED_BUDGET')),
  target_files_json TEXT NOT NULL,
  finding_payload_json TEXT NOT NULL,
  plan_json TEXT,
  worktree_path TEXT,
  base_commit_sha TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  turns_spent INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_queue_status_score
  ON work_queue(status, priority_score DESC, created_at_ms ASC);

CREATE TABLE IF NOT EXISTS done_set (
  fingerprint TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_collector TEXT NOT NULL,
  base_commit_sha TEXT,
  shipped_commit_sha TEXT,
  target_blob_hashes_json TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_done_set_completed ON done_set(completed_at_ms DESC);

CREATE TABLE IF NOT EXISTS tombstone_registry (
  fingerprint TEXT PRIMARY KEY,
  failure_stage TEXT NOT NULL,
  failure_reason TEXT NOT NULL,
  last_diff_hash TEXT,
  target_blob_hashes_json TEXT NOT NULL,
  strike_count INTEGER NOT NULL DEFAULT 1,
  cooldown_until_ms INTEGER NOT NULL,
  quarantine_git_ref TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS step_journal (
  task_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  phase TEXT NOT NULL,
  tool_name TEXT,
  tool_args_hash TEXT,
  git_tree_hash TEXT,
  error_signature TEXT,
  tokens_delta INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (task_id, step_index)
);

CREATE TABLE IF NOT EXISTS learned_patterns (
  pattern_id TEXT PRIMARY KEY,
  scope_glob TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('INVARIANT','ANTI_PATTERN','TOOL_HINT')),
  rule_summary TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_from_task_id TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learned_patterns_confidence
  ON learned_patterns(confidence DESC);

CREATE TABLE IF NOT EXISTS flaky_tests (
  test_id TEXT PRIMARY KEY,
  flake_rate REAL NOT NULL,
  quarantined_at_ms INTEGER,
  remediation_task_id TEXT
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  window_key TEXT PRIMARY KEY,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  window_start_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discarded_findings (
  fingerprint TEXT PRIMARY KEY,
  source_collector TEXT NOT NULL,
  priority_score REAL NOT NULL,
  reason TEXT NOT NULL,
  finding_payload_json TEXT NOT NULL,
  discarded_at_ms INTEGER NOT NULL
);
`;

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp + version/variant + random. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = Date.now();
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** Cooldown (epoch ms, or -1 for permanent) for a given strike count. */
export function cooldownUntilForStrike(strikeCount: number, nowMs: number): number {
  if (strikeCount >= MAX_STRIKES_BEFORE_PERMANENT) return -1;
  const last = TOMBSTONE_COOLDOWNS_MS[TOMBSTONE_COOLDOWNS_MS.length - 1] ?? 60 * 60 * 1000;
  const duration =
    TOMBSTONE_COOLDOWNS_MS[Math.min(strikeCount, TOMBSTONE_COOLDOWNS_MS.length) - 1] ?? last;
  return nowMs + duration;
}

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new Error(`state store: expected string for ${key}`);
  return v;
}

function nullableStr(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  throw new Error(`state store: expected string for ${key}`);
}

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') throw new Error(`state store: expected number for ${key}`);
  return v;
}

function json(row: Row, key: string): unknown {
  return JSON.parse(str(row, key)) as unknown;
}

/**
 * Minimal glob matcher: a star spans within one path segment, a question
 * mark matches one character within a segment, and a double star followed
 * by a slash spans zero or more directories.
 */
export function globMatches(glob: string, path: string): boolean {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // A double star followed by a slash matches zero or more directories;
        // a trailing double star matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re).test(path);
}

/** ~150-token cap for rule summaries: ~4 chars per token, truncate at 600. */
const RULE_SUMMARY_MAX_CHARS = 600;

export interface AutonomousStateStoreOptions {
  repoRoot: string;
  /** Defaults to `<repoRoot>/.omnexx/autonomous.db`. Use ':memory:' for tests. */
  dbPath?: string;
}

export class AutonomousStateStore {
  private readonly repoRoot: string;
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(opts: AutonomousStateStoreOptions) {
    this.repoRoot = opts.repoRoot;
    this.dbPath = opts.dbPath ?? join(opts.repoRoot, AUTONOMOUS_DB_REL_PATH);
  }

  get path(): string {
    return this.dbPath;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  async open(): Promise<void> {
    if (this.db !== null) return;
    if (this.dbPath !== ':memory:') await mkdir(dirname(this.dbPath), { recursive: true });
    // Dynamic import so tsup does not rewrite the built-in module specifier.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(this.dbPath, { open: true });
    if (this.dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode=WAL;');
    }
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private requireDb(): DatabaseSync {
    if (this.db === null) throw new Error('AutonomousStateStore is not open; call open() first');
    return this.db;
  }

  /** Run fn inside a single IMMEDIATE transaction; rolls back on throw. */
  private transaction<T>(fn: () => T): T {
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back / no transaction; surface the original error.
      }
      throw err;
    }
  }

  // -- work queue -----------------------------------------------------------

  enqueueTask(input: EnqueueTaskInput): QueuedTask {
    const now = Date.now();
    return this.transaction(() => {
      const db = this.requireDb();
      const taskId = uuidv7();
      db.prepare(
        `INSERT OR IGNORE INTO work_queue
          (task_id, fingerprint, source_collector, priority_score, status,
           target_files_json, finding_payload_json, base_commit_sha,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        input.fingerprint,
        input.sourceCollector,
        input.priorityScore,
        JSON.stringify([...input.targetFiles]),
        JSON.stringify(input.findingPayload),
        input.baseCommitSha ?? null,
        now,
        now,
      );
      const row = db
        .prepare('SELECT * FROM work_queue WHERE fingerprint = ?')
        .get(input.fingerprint) as Row | undefined;
      if (row === undefined) throw new Error('enqueueTask: failed to read back task');
      return rowToTask(row);
    });
  }

  /** Claim the highest-priority QUEUED task, moving it to PLANNING. */
  popNextTask(): QueuedTask | null {
    return this.transaction(() => {
      const db = this.requireDb();
      const row = db
        .prepare(
          `SELECT * FROM work_queue WHERE status = 'QUEUED'
            ORDER BY priority_score DESC, created_at_ms ASC LIMIT 1`,
        )
        .get() as Row | undefined;
      if (row === undefined) return null;
      const now = Date.now();
      db.prepare(
        "UPDATE work_queue SET status = 'PLANNING', updated_at_ms = ? WHERE task_id = ?",
      ).run(now, str(row, 'task_id'));
      const updated = db
        .prepare('SELECT * FROM work_queue WHERE task_id = ?')
        .get(str(row, 'task_id')) as Row | undefined;
      if (updated === undefined) throw new Error('popNextTask: lost claimed task');
      return rowToTask(updated);
    });
  }

  getTask(taskId: string): QueuedTask | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM work_queue WHERE task_id = ?')
      .get(taskId) as Row | undefined;
    return row === undefined ? null : rowToTask(row);
  }

  getTaskByFingerprint(fingerprint: string): QueuedTask | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM work_queue WHERE fingerprint = ?')
      .get(fingerprint) as Row | undefined;
    return row === undefined ? null : rowToTask(row);
  }

  listTasks(status?: TaskStatus): QueuedTask[] {
    const db = this.requireDb();
    const rows =
      status === undefined
        ? (db.prepare('SELECT * FROM work_queue ORDER BY priority_score DESC').all() as Row[])
        : (db
            .prepare('SELECT * FROM work_queue WHERE status = ? ORDER BY priority_score DESC')
            .all(status) as Row[]);
    return rows.map(rowToTask);
  }

  updateTaskStatus(taskId: string, status: TaskStatus, patch: TaskPatch = {}): QueuedTask | null {
    return this.transaction(() => {
      const db = this.requireDb();
      const sets: string[] = ['status = ?', 'updated_at_ms = ?'];
      const params: SQLInputValue[] = [status, Date.now()];
      if (patch.plan !== undefined) {
        sets.push('plan_json = ?');
        params.push(JSON.stringify(patch.plan));
      }
      if (patch.worktreePath !== undefined) {
        sets.push('worktree_path = ?');
        params.push(patch.worktreePath);
      }
      if (patch.baseCommitSha !== undefined) {
        sets.push('base_commit_sha = ?');
        params.push(patch.baseCommitSha);
      }
      if (patch.attemptCount !== undefined) {
        sets.push('attempt_count = ?');
        params.push(patch.attemptCount);
      }
      if (patch.tokensSpent !== undefined) {
        sets.push('tokens_spent = ?');
        params.push(patch.tokensSpent);
      }
      if (patch.turnsSpent !== undefined) {
        sets.push('turns_spent = ?');
        params.push(patch.turnsSpent);
      }
      params.push(taskId);
      const info = db
        .prepare(`UPDATE work_queue SET ${sets.join(', ')} WHERE task_id = ?`)
        .run(...params);
      if (info.changes === 0) return null;
      const row = db.prepare('SELECT * FROM work_queue WHERE task_id = ?').get(taskId) as
        Row | undefined;
      return row === undefined ? null : rowToTask(row);
    });
  }

  /** Increment attempt/tokens/turns counters atomically. */
  addTaskUsage(
    taskId: string,
    delta: { tokens?: number; turns?: number; attempts?: number },
  ): void {
    this.requireDb()
      .prepare(
        `UPDATE work_queue SET
           tokens_spent = tokens_spent + ?,
           turns_spent = turns_spent + ?,
           attempt_count = attempt_count + ?,
           updated_at_ms = ?
         WHERE task_id = ?`,
      )
      .run(delta.tokens ?? 0, delta.turns ?? 0, delta.attempts ?? 0, Date.now(), taskId);
  }

  /** Delete a queued task by id (used by `queue drop`). Returns true if one was deleted. */
  deleteTask(taskId: string): boolean {
    const info = this.requireDb().prepare('DELETE FROM work_queue WHERE task_id = ?').run(taskId);
    return info.changes > 0;
  }

  // -- step journal ---------------------------------------------------------

  recordStep(
    taskId: string,
    step: {
      phase: string;
      toolName?: string;
      toolArgsHash?: string;
      gitTreeHash?: string;
      errorSignature?: string;
      tokensDelta?: number;
    },
  ): StepRecord {
    return this.transaction(() => {
      const db = this.requireDb();
      const maxRow = db
        .prepare('SELECT COALESCE(MAX(step_index), -1) AS m FROM step_journal WHERE task_id = ?')
        .get(taskId) as Row | undefined;
      const stepIndex = num(maxRow ?? { m: -1 }, 'm') + 1;
      const now = Date.now();
      db.prepare(
        `INSERT INTO step_journal
           (task_id, step_index, phase, tool_name, tool_args_hash,
            git_tree_hash, error_signature, tokens_delta, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        stepIndex,
        step.phase,
        step.toolName ?? null,
        step.toolArgsHash ?? null,
        step.gitTreeHash ?? null,
        step.errorSignature ?? null,
        step.tokensDelta ?? 0,
        now,
      );
      return {
        taskId,
        stepIndex,
        phase: step.phase,
        toolName: step.toolName ?? null,
        toolArgsHash: step.toolArgsHash ?? null,
        gitTreeHash: step.gitTreeHash ?? null,
        errorSignature: step.errorSignature ?? null,
        tokensDelta: step.tokensDelta ?? 0,
        createdAtMs: now,
      };
    });
  }

  getSteps(taskId: string): StepRecord[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM step_journal WHERE task_id = ? ORDER BY step_index ASC')
      .all(taskId) as Row[];
    return rows.map((row) => ({
      taskId: str(row, 'task_id'),
      stepIndex: num(row, 'step_index'),
      phase: str(row, 'phase'),
      toolName: nullableStr(row, 'tool_name'),
      toolArgsHash: nullableStr(row, 'tool_args_hash'),
      gitTreeHash: nullableStr(row, 'git_tree_hash'),
      errorSignature: nullableStr(row, 'error_signature'),
      tokensDelta: num(row, 'tokens_delta'),
      createdAtMs: num(row, 'created_at_ms'),
    }));
  }

  // -- done set / tombstones ------------------------------------------------

  markDone(
    taskId: string,
    opts: {
      shippedCommitSha?: string;
      deliveryMode: string;
      targetBlobHashes: Record<string, string>;
    },
  ): DoneEntry | null {
    return this.transaction(() => {
      const db = this.requireDb();
      const task = this.getTask(taskId);
      if (task === null) return null;
      const now = Date.now();
      db.prepare(
        `INSERT OR REPLACE INTO done_set
           (fingerprint, task_id, source_collector, base_commit_sha,
            shipped_commit_sha, target_blob_hashes_json, delivery_mode, completed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.fingerprint,
        taskId,
        task.sourceCollector,
        task.baseCommitSha,
        opts.shippedCommitSha ?? null,
        JSON.stringify(opts.targetBlobHashes),
        opts.deliveryMode,
        now,
      );
      db.prepare('DELETE FROM work_queue WHERE task_id = ?').run(taskId);
      return {
        fingerprint: task.fingerprint,
        taskId,
        sourceCollector: task.sourceCollector,
        baseCommitSha: task.baseCommitSha,
        shippedCommitSha: opts.shippedCommitSha ?? null,
        targetBlobHashes: opts.targetBlobHashes,
        deliveryMode: opts.deliveryMode,
        completedAtMs: now,
      };
    });
  }

  /**
   * Tombstone a task, escalating strikes on repeat failure. Each strike
   * lengthens the cooldown (1h, 6h, 24h, 7d); the 5th strike is permanent
   * (cooldown_until_ms = -1). The task is removed from the work queue when
   * its taskId is known. The same diff hash failing again does not reset
   * the strike count — it increments it.
   */
  tombstone(input: {
    taskId?: string;
    fingerprint: string;
    failure: TombstoneFailure;
  }): TombstoneEntry {
    const now = Date.now();
    return this.transaction(() => {
      const db = this.requireDb();
      const existing = db
        .prepare('SELECT * FROM tombstone_registry WHERE fingerprint = ?')
        .get(input.fingerprint) as Row | undefined;
      const strikeCount = existing === undefined ? 1 : num(existing, 'strike_count') + 1;
      const cooldownUntilMs = cooldownUntilForStrike(strikeCount, now);
      db.prepare(
        `INSERT INTO tombstone_registry
           (fingerprint, failure_stage, failure_reason, last_diff_hash,
            target_blob_hashes_json, strike_count, cooldown_until_ms,
            quarantine_git_ref, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           failure_stage = excluded.failure_stage,
           failure_reason = excluded.failure_reason,
           last_diff_hash = excluded.last_diff_hash,
           target_blob_hashes_json = excluded.target_blob_hashes_json,
           strike_count = excluded.strike_count,
           cooldown_until_ms = excluded.cooldown_until_ms,
           quarantine_git_ref = excluded.quarantine_git_ref,
           updated_at_ms = excluded.updated_at_ms`,
      ).run(
        input.fingerprint,
        input.failure.failureStage,
        input.failure.failureReason,
        input.failure.lastDiffHash ?? null,
        JSON.stringify(input.failure.targetBlobHashes),
        strikeCount,
        cooldownUntilMs,
        input.failure.quarantineGitRef ?? null,
        now,
      );
      if (input.taskId !== undefined) {
        db.prepare('DELETE FROM work_queue WHERE task_id = ?').run(input.taskId);
      }
      return {
        fingerprint: input.fingerprint,
        failureStage: input.failure.failureStage,
        failureReason: input.failure.failureReason,
        lastDiffHash: input.failure.lastDiffHash ?? null,
        targetBlobHashes: input.failure.targetBlobHashes,
        strikeCount,
        cooldownUntilMs,
        quarantineGitRef: input.failure.quarantineGitRef ?? null,
        updatedAtMs: now,
      };
    });
  }

  isDone(fingerprint: string): boolean {
    const row = this.requireDb()
      .prepare('SELECT 1 AS one FROM done_set WHERE fingerprint = ?')
      .get(fingerprint) as Row | undefined;
    return row !== undefined;
  }

  getDoneEntry(fingerprint: string): DoneEntry | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM done_set WHERE fingerprint = ?')
      .get(fingerprint) as Row | undefined;
    if (row === undefined) return null;
    return {
      fingerprint: str(row, 'fingerprint'),
      taskId: str(row, 'task_id'),
      sourceCollector: str(row, 'source_collector'),
      baseCommitSha: nullableStr(row, 'base_commit_sha'),
      shippedCommitSha: nullableStr(row, 'shipped_commit_sha'),
      targetBlobHashes: json(row, 'target_blob_hashes_json') as Record<string, string>,
      deliveryMode: str(row, 'delivery_mode'),
      completedAtMs: num(row, 'completed_at_ms'),
    };
  }

  /** All done_set entries, oldest first (used by boot step 4 pruning). */
  listDone(): DoneEntry[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM done_set ORDER BY completed_at_ms ASC')
      .all() as Row[];
    return rows.map((row) => ({
      fingerprint: str(row, 'fingerprint'),
      taskId: str(row, 'task_id'),
      sourceCollector: str(row, 'source_collector'),
      baseCommitSha: nullableStr(row, 'base_commit_sha'),
      shippedCommitSha: nullableStr(row, 'shipped_commit_sha'),
      targetBlobHashes: json(row, 'target_blob_hashes_json') as Record<string, string>,
      deliveryMode: str(row, 'delivery_mode'),
      completedAtMs: num(row, 'completed_at_ms'),
    }));
  }

  /** Delete a done_set entry by fingerprint. Returns true if one was deleted. */
  deleteDone(fingerprint: string): boolean {
    const info = this.requireDb()
      .prepare('DELETE FROM done_set WHERE fingerprint = ?')
      .run(fingerprint);
    return info.changes > 0;
  }

  getTombstone(fingerprint: string): TombstoneEntry | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM tombstone_registry WHERE fingerprint = ?')
      .get(fingerprint) as Row | undefined;
    if (row === undefined) return null;
    return rowToTombstone(row);
  }

  /** Active tombstone: present and either permanent or still cooling down. */
  isTombstoned(fingerprint: string, nowMs: number = Date.now()): boolean {
    const entry = this.getTombstone(fingerprint);
    if (entry === null) return false;
    return entry.cooldownUntilMs === -1 || entry.cooldownUntilMs > nowMs;
  }

  clearTombstone(fingerprint: string): void {
    this.requireDb()
      .prepare('DELETE FROM tombstone_registry WHERE fingerprint = ?')
      .run(fingerprint);
  }

  /**
   * Stamp a tombstone permanent (cooldown -1): used when a human rejects a
   * task in review — the verdict stands until the target blobs change.
   * Returns true if a tombstone row was updated.
   */
  makeTombstonePermanent(fingerprint: string): boolean {
    const info = this.requireDb()
      .prepare('UPDATE tombstone_registry SET cooldown_until_ms = -1 WHERE fingerprint = ?')
      .run(fingerprint);
    return info.changes > 0;
  }

  /**
   * True when a tombstoned fingerprint may be retried: no tombstone, an
   * expired cooldown, or the target blobs changed since the failure was
   * recorded (external invalidation — a human or another agent edited the
   * files, so the old failure may no longer apply).
   */
  isTombstoneUnlocked(fingerprint: string, repoRoot: string, nowMs: number = Date.now()): boolean {
    const entry = this.getTombstone(fingerprint);
    if (entry === null) return true;
    if (entry.cooldownUntilMs !== -1 && entry.cooldownUntilMs <= nowMs) return true;
    return blobsChanged(repoRoot, fingerprint, entry.targetBlobHashes).changed;
  }

  /** True when any of the files was touched by an autonomous task since `sinceMs`. */
  filesTouchedSince(files: readonly string[], sinceMs: number): boolean {
    if (files.length === 0) return false;
    const wanted = new Set(files);
    const db = this.requireDb();
    const doneRows = db
      .prepare('SELECT target_blob_hashes_json FROM done_set WHERE completed_at_ms >= ?')
      .all(sinceMs) as Row[];
    for (const row of doneRows) {
      const hashes = json(row, 'target_blob_hashes_json') as Record<string, string>;
      if (Object.keys(hashes).some((f) => wanted.has(f))) return true;
    }
    const queueRows = db
      .prepare(
        `SELECT target_files_json FROM work_queue
          WHERE status IN ('PLANNING','IMPLEMENTING','VERIFYING') AND updated_at_ms >= ?`,
      )
      .all(sinceMs) as Row[];
    for (const row of queueRows) {
      const targets = json(row, 'target_files_json') as string[];
      if (targets.some((f) => wanted.has(f))) return true;
    }
    return false;
  }

  // -- learned patterns -----------------------------------------------------

  recordPattern(input: {
    scopeGlob: string;
    patternType: PatternType;
    ruleSummary: string;
    confidence: number;
    createdFromTaskId?: string;
  }): LearnedPattern {
    const summary =
      input.ruleSummary.length > RULE_SUMMARY_MAX_CHARS
        ? `${input.ruleSummary.slice(0, RULE_SUMMARY_MAX_CHARS - 3)}...`
        : input.ruleSummary;
    const pattern: LearnedPattern = {
      patternId: uuidv7(),
      scopeGlob: input.scopeGlob,
      patternType: input.patternType,
      ruleSummary: summary,
      confidence: Math.min(1, Math.max(0, input.confidence)),
      createdFromTaskId: input.createdFromTaskId ?? null,
      createdAtMs: Date.now(),
    };
    this.requireDb()
      .prepare(
        `INSERT INTO learned_patterns
           (pattern_id, scope_glob, pattern_type, rule_summary,
            confidence, created_from_task_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pattern.patternId,
        pattern.scopeGlob,
        pattern.patternType,
        pattern.ruleSummary,
        pattern.confidence,
        pattern.createdFromTaskId,
        pattern.createdAtMs,
      );
    return pattern;
  }

  /** Patterns whose scope glob applies to `scope` (usually a file path). */
  getLearnedPatterns(scope: string): LearnedPattern[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM learned_patterns ORDER BY confidence DESC')
      .all() as Row[];
    return rows
      .map((row) => ({
        patternId: str(row, 'pattern_id'),
        scopeGlob: str(row, 'scope_glob'),
        patternType: str(row, 'pattern_type') as PatternType,
        ruleSummary: str(row, 'rule_summary'),
        confidence: num(row, 'confidence'),
        createdFromTaskId: nullableStr(row, 'created_from_task_id'),
        createdAtMs: num(row, 'created_at_ms'),
      }))
      .filter((p) => p.scopeGlob === scope || globMatches(p.scopeGlob, scope));
  }

  // -- flaky tests ----------------------------------------------------------

  recordFlakyTest(
    testId: string,
    flakeRate: number,
    opts: { remediationTaskId?: string; quarantine?: boolean } = {},
  ): FlakyTest {
    const now = Date.now();
    // Default: quarantine once the flake rate reaches 30%.
    const quarantine = opts.quarantine ?? flakeRate >= 0.3;
    return this.transaction(() => {
      const db = this.requireDb();
      const existing = db.prepare('SELECT * FROM flaky_tests WHERE test_id = ?').get(testId) as
        Row | undefined;
      const existingQuarantinedAtMs =
        typeof existing?.quarantined_at_ms === 'number' ? existing.quarantined_at_ms : null;
      const next: FlakyTest = {
        testId,
        flakeRate: Math.min(1, Math.max(0, flakeRate)),
        quarantinedAtMs: quarantine ? (existingQuarantinedAtMs ?? now) : existingQuarantinedAtMs,
        remediationTaskId:
          opts.remediationTaskId ??
          (existing === undefined ? null : nullableStr(existing, 'remediation_task_id')),
      };
      db.prepare(
        `INSERT INTO flaky_tests (test_id, flake_rate, quarantined_at_ms, remediation_task_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(test_id) DO UPDATE SET
           flake_rate = excluded.flake_rate,
           quarantined_at_ms = excluded.quarantined_at_ms,
           remediation_task_id = excluded.remediation_task_id`,
      ).run(next.testId, next.flakeRate, next.quarantinedAtMs, next.remediationTaskId);
      return next;
    });
  }

  getFlakyTests(): FlakyTest[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM flaky_tests ORDER BY flake_rate DESC')
      .all() as Row[];
    return rows.map((row) => ({
      testId: str(row, 'test_id'),
      flakeRate: num(row, 'flake_rate'),
      quarantinedAtMs:
        row.quarantined_at_ms === null || row.quarantined_at_ms === undefined
          ? null
          : Number(row.quarantined_at_ms),
      remediationTaskId: nullableStr(row, 'remediation_task_id'),
    }));
  }

  // -- discarded findings / budget ledger (budget v2 scaffolding) -----------

  recordDiscardedFinding(input: {
    fingerprint: string;
    sourceCollector: string;
    priorityScore: number;
    reason: string;
    findingPayload: unknown;
  }): void {
    this.requireDb()
      .prepare(
        `INSERT OR REPLACE INTO discarded_findings
           (fingerprint, source_collector, priority_score, reason,
            finding_payload_json, discarded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fingerprint,
        input.sourceCollector,
        input.priorityScore,
        input.reason,
        JSON.stringify(input.findingPayload),
        Date.now(),
      );
  }

  getDiscardedFinding(fingerprint: string): DiscardedFinding | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM discarded_findings WHERE fingerprint = ?')
      .get(fingerprint) as Row | undefined;
    if (row === undefined) return null;
    return {
      fingerprint: str(row, 'fingerprint'),
      sourceCollector: str(row, 'source_collector'),
      priorityScore: num(row, 'priority_score'),
      reason: str(row, 'reason'),
      findingPayload: json(row, 'finding_payload_json'),
      discardedAtMs: num(row, 'discarded_at_ms'),
    };
  }

  recordBudgetSpend(windowKey: string, tokens: number, costUsd: number): BudgetWindow {
    return this.transaction(() => {
      const db = this.requireDb();
      const existing = db
        .prepare('SELECT * FROM budget_ledger WHERE window_key = ?')
        .get(windowKey) as Row | undefined;
      const next: BudgetWindow =
        existing === undefined
          ? {
              windowKey,
              tokensSpent: tokens,
              costUsd,
              windowStartMs: Date.now(),
            }
          : {
              windowKey,
              tokensSpent: num(existing, 'tokens_spent') + tokens,
              costUsd: num(existing, 'cost_usd') + costUsd,
              windowStartMs: num(existing, 'window_start_ms'),
            };
      db.prepare(
        `INSERT INTO budget_ledger (window_key, tokens_spent, cost_usd, window_start_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(window_key) DO UPDATE SET
           tokens_spent = excluded.tokens_spent,
           cost_usd = excluded.cost_usd`,
      ).run(next.windowKey, next.tokensSpent, next.costUsd, next.windowStartMs);
      return next;
    });
  }

  getBudgetWindow(windowKey: string): BudgetWindow | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM budget_ledger WHERE window_key = ?')
      .get(windowKey) as Row | undefined;
    if (row === undefined) return null;
    return {
      windowKey: str(row, 'window_key'),
      tokensSpent: num(row, 'tokens_spent'),
      costUsd: num(row, 'cost_usd'),
      windowStartMs: num(row, 'window_start_ms'),
    };
  }

  // -- git-notes sync -------------------------------------------------------

  /**
   * Write a JSON receipt for a fingerprint onto `commitSha` in
   * `refs/notes/omnexx-auto`. The note makes completion visible to any
   * clone even if `.omnexx/autonomous.db` is lost. Returns false when git
   * cannot attach the note (e.g. no such commit).
   */
  async syncReceiptToGitNotes(
    fingerprint: string,
    status: ReceiptStatus,
    commitSha: string,
    extra: ReceiptExtra = {},
  ): Promise<boolean> {
    // git accepts notes on object ids that do not exist in the repo, so
    // verify the target object first — a receipt for a phantom commit is
    // worse than no receipt.
    const exists = await git(this.repoRoot, ['cat-file', '-e', commitSha], {
      allowFailure: true,
    });
    if (exists.exitCode !== 0) return false;
    const receipt = {
      fingerprint,
      status,
      commitSha,
      updatedAtMs: Date.now(),
      ...extra,
    };
    const result = await git(
      this.repoRoot,
      ['notes', '--ref', GIT_NOTES_REF, 'add', '-f', '-m', JSON.stringify(receipt), commitSha],
      { allowFailure: true },
    );
    return result.exitCode === 0;
  }

  /**
   * Read receipts back from `refs/notes/omnexx-auto` and merge them into
   * the local done-set / tombstone registry (local rows win on conflict).
   * Returns counts of receipts applied vs skipped.
   */
  async hydrateFromGitNotes(): Promise<{ done: number; tombstoned: number; skipped: number }> {
    const counts = { done: 0, tombstoned: 0, skipped: 0 };
    const list = await git(this.repoRoot, ['notes', '--ref', GIT_NOTES_REF, 'list'], {
      allowFailure: true,
    });
    if (list.exitCode !== 0 || list.stdout.trim() === '') return counts;
    const db = this.requireDb();
    for (const line of list.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const commitSha = parts[1];
      if (commitSha === undefined) {
        counts.skipped += 1;
        continue;
      }
      const show = await git(this.repoRoot, ['notes', '--ref', GIT_NOTES_REF, 'show', commitSha], {
        allowFailure: true,
      });
      if (show.exitCode !== 0) {
        counts.skipped += 1;
        continue;
      }
      let receipt: {
        fingerprint?: unknown;
        status?: unknown;
        sourceCollector?: unknown;
        baseCommitSha?: unknown;
        shippedCommitSha?: unknown;
        targetBlobHashes?: unknown;
        deliveryMode?: unknown;
        failureStage?: unknown;
        failureReason?: unknown;
        strikeCount?: unknown;
        cooldownUntilMs?: unknown;
        completedAtMs?: unknown;
        updatedAtMs?: unknown;
      };
      try {
        receipt = JSON.parse(show.stdout) as typeof receipt;
      } catch {
        counts.skipped += 1;
        continue;
      }
      if (typeof receipt.fingerprint !== 'string' || typeof receipt.status !== 'string') {
        counts.skipped += 1;
        continue;
      }
      const atMs = typeof receipt.updatedAtMs === 'number' ? receipt.updatedAtMs : Date.now();
      if (receipt.status === 'done') {
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO done_set
               (fingerprint, task_id, source_collector, base_commit_sha,
                shipped_commit_sha, target_blob_hashes_json, delivery_mode, completed_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            receipt.fingerprint,
            `notes:${commitSha.slice(0, 12)}`,
            typeof receipt.sourceCollector === 'string' ? receipt.sourceCollector : 'git-notes',
            typeof receipt.baseCommitSha === 'string' ? receipt.baseCommitSha : null,
            typeof receipt.shippedCommitSha === 'string' ? receipt.shippedCommitSha : commitSha,
            JSON.stringify((receipt.targetBlobHashes as Record<string, string> | undefined) ?? {}),
            typeof receipt.deliveryMode === 'string' ? receipt.deliveryMode : 'commit',
            typeof receipt.completedAtMs === 'number' ? receipt.completedAtMs : atMs,
          );
        if (info.changes > 0) counts.done += 1;
        else counts.skipped += 1;
      } else if (receipt.status === 'tombstoned') {
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO tombstone_registry
               (fingerprint, failure_stage, failure_reason, last_diff_hash,
                target_blob_hashes_json, strike_count, cooldown_until_ms,
                quarantine_git_ref, updated_at_ms)
             VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
          )
          .run(
            receipt.fingerprint,
            typeof receipt.failureStage === 'string' ? receipt.failureStage : 'unknown',
            typeof receipt.failureReason === 'string' ? receipt.failureReason : 'hydrated',
            JSON.stringify((receipt.targetBlobHashes as Record<string, string> | undefined) ?? {}),
            typeof receipt.strikeCount === 'number' ? receipt.strikeCount : 1,
            typeof receipt.cooldownUntilMs === 'number' ? receipt.cooldownUntilMs : -1,
            atMs,
          );
        if (info.changes > 0) counts.tombstoned += 1;
        else counts.skipped += 1;
      } else {
        counts.skipped += 1;
      }
    }
    return counts;
  }
}

function rowToTask(row: Row): QueuedTask {
  return {
    taskId: str(row, 'task_id'),
    fingerprint: str(row, 'fingerprint'),
    sourceCollector: str(row, 'source_collector'),
    priorityScore: num(row, 'priority_score'),
    status: str(row, 'status') as TaskStatus,
    targetFiles: json(row, 'target_files_json') as string[],
    findingPayload: json(row, 'finding_payload_json'),
    plan: typeof row.plan_json === 'string' ? (JSON.parse(row.plan_json) as unknown) : null,
    worktreePath: nullableStr(row, 'worktree_path'),
    baseCommitSha: nullableStr(row, 'base_commit_sha'),
    attemptCount: num(row, 'attempt_count'),
    tokensSpent: num(row, 'tokens_spent'),
    turnsSpent: num(row, 'turns_spent'),
    createdAtMs: num(row, 'created_at_ms'),
    updatedAtMs: num(row, 'updated_at_ms'),
  };
}

function rowToTombstone(row: Row): TombstoneEntry {
  return {
    fingerprint: str(row, 'fingerprint'),
    failureStage: str(row, 'failure_stage'),
    failureReason: str(row, 'failure_reason'),
    lastDiffHash: nullableStr(row, 'last_diff_hash'),
    targetBlobHashes: json(row, 'target_blob_hashes_json') as Record<string, string>,
    strikeCount: num(row, 'strike_count'),
    cooldownUntilMs: num(row, 'cooldown_until_ms'),
    quarantineGitRef: nullableStr(row, 'quarantine_git_ref'),
    updatedAtMs: num(row, 'updated_at_ms'),
  };
}
