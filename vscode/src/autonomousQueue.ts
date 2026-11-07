/**
 * The autonomous queue tree view: the daemon's work queue (task id, priority score, status,
 * collector) read from `.omnexx/autonomous.db` through the state store's real schema
 * (work_queue / tombstone_registry).
 *
 * The extension host's Node may not have `node:sqlite` (it needs Node 22.5+; VS Code's
 * Electron still ships Node 20), so the read tries a dynamic import first and falls back to
 * `omnexx queue list --json` through the bundled CLI. Either way the DB is only ever read.
 */
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { daemonStatus, queueListJson } from './cli.js';
import { primaryFolder } from './tree.js';

export interface QueueTask {
  id: string;
  fingerprint: string;
  title: string;
  description: string;
  collector: string;
  priorityScore: number;
  status: string;
  targetFiles: string[];
  worktreePath: string | null;
}

export interface QueueTombstone {
  fingerprint: string;
  failureStage: string;
  failureReason: string;
  strikeCount: number;
  cooldownUntilMs: number;
}

export interface QueueSnapshot {
  tasks: QueueTask[];
  tombstones: QueueTombstone[];
  /** 'sqlite' when the DB was read directly, 'cli' when the CLI was shelled out to. */
  source: 'sqlite' | 'cli';
  /** Set when no DB exists yet (the daemon has never run) or the read failed. */
  note?: string | undefined;
}

export type QueueNode =
  | { kind: 'action'; label: string; description: string; tooltip: string; icon: string; command: string }
  | { kind: 'task'; task: QueueTask }
  | { kind: 'tombstones'; items: QueueTombstone[] }
  | { kind: 'tombstone'; item: QueueTombstone }
  | { kind: 'message'; text: string };

interface SqliteStatement {
  all: (...params: unknown[]) => Record<string, unknown>[];
}

interface SqliteDb {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function payloadText(payload: unknown, keys: readonly string[]): string {
  if (typeof payload !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== 'object') return '';
    const record = parsed as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  } catch {
    // Not JSON; nothing to pull out of it.
  }
  return '';
}

function asTask(row: Record<string, unknown>): QueueTask {
  const collector = str(row.source_collector) ?? 'unknown';
  return {
    id: str(row.task_id) ?? '',
    fingerprint: str(row.fingerprint) ?? '',
    title:
      payloadText(row.finding_payload_json, ['title', 'summary', 'message']) ||
      `${collector} finding`,
    description: payloadText(row.finding_payload_json, ['description', 'detail', 'body']),
    collector,
    priorityScore: num(row.priority_score) ?? 0,
    status: str(row.status) ?? 'QUEUED',
    targetFiles: (() => {
      try {
        const parsed: unknown = JSON.parse(str(row.target_files_json) ?? '[]');
        return Array.isArray(parsed)
          ? parsed.filter((f): f is string => typeof f === 'string')
          : [];
      } catch {
        return [];
      }
    })(),
    worktreePath: str(row.worktree_path),
  };
}

function asTombstone(row: Record<string, unknown>): QueueTombstone {
  return {
    fingerprint: str(row.fingerprint) ?? '',
    failureStage: str(row.failure_stage) ?? '',
    failureReason: str(row.failure_reason) ?? '',
    strikeCount: num(row.strike_count) ?? 0,
    cooldownUntilMs: num(row.cooldown_until_ms) ?? 0,
  };
}

/** A task row as `queue list --json` returns it (the CLI's QueueTaskView shape). */
function asTaskFromCli(row: Record<string, unknown>): QueueTask {
  return {
    id: str(row.id) ?? '',
    fingerprint: str(row.fingerprint) ?? '',
    title: str(row.title) ?? '',
    description: str(row.description) ?? '',
    collector: str(row.collector) ?? 'unknown',
    priorityScore: num(row.priorityScore) ?? num(row.priority_score) ?? 0,
    status: str(row.status) ?? 'QUEUED',
    targetFiles: Array.isArray(row.targetFiles)
      ? row.targetFiles.filter((f): f is string => typeof f === 'string')
      : [],
    worktreePath: str(row.worktreePath) ?? str(row.worktree_path),
  };
}

function asTombstoneFromCli(row: Record<string, unknown>): QueueTombstone {
  return {
    fingerprint: str(row.fingerprint) ?? '',
    failureStage: str(row.failureStage) ?? str(row.failure_stage) ?? '',
    failureReason: str(row.failureReason) ?? str(row.failure_reason) ?? '',
    strikeCount: num(row.strikeCount) ?? num(row.strike_count) ?? 0,
    cooldownUntilMs: num(row.cooldownUntilMs) ?? num(row.cooldown_until_ms) ?? 0,
  };
}

async function readQueueFromSqlite(dbPath: string): Promise<QueueSnapshot | null> {
  let sqlite: SqliteModule;
  try {
    sqlite = (await import('node:sqlite')) as SqliteModule;
  } catch {
    return null;
  }
  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const tasks = db
      .prepare(
        `SELECT task_id, fingerprint, source_collector, priority_score, status,
                finding_payload_json, target_files_json, worktree_path
         FROM work_queue ORDER BY priority_score DESC`,
      )
      .all()
      .map(asTask);
    let tombstones: QueueTombstone[] = [];
    try {
      tombstones = db
        .prepare(
          `SELECT fingerprint, failure_stage, failure_reason, strike_count, cooldown_until_ms
           FROM tombstone_registry ORDER BY updated_at_ms DESC`,
        )
        .all()
        .map(asTombstone);
    } catch {
      tombstones = [];
    }
    return { tasks, tombstones, source: 'sqlite' };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Read the queue for a folder: direct SQLite when the host allows it, else the CLI. */
export async function readAutonomousQueue(cwd: string | undefined): Promise<QueueSnapshot> {
  if (!cwd) return { tasks: [], tombstones: [], source: 'cli', note: 'Open a folder first.' };
  const dbPath = join(cwd, '.omnexx', 'autonomous.db');
  if (!existsSync(dbPath))
    return {
      tasks: [],
      tombstones: [],
      source: 'cli',
      note: 'No daemon state yet (.omnexx/autonomous.db not found).',
    };
  const direct = await readQueueFromSqlite(dbPath);
  if (direct) return direct;
  try {
    const parsed = JSON.parse(await queueListJson(cwd)) as {
      tasks?: Record<string, unknown>[];
      tombstones?: Record<string, unknown>[];
    };
    return {
      tasks: (parsed.tasks ?? []).map(asTaskFromCli),
      tombstones: (parsed.tombstones ?? []).map(asTombstoneFromCli),
      source: 'cli',
    };
  } catch (err) {
    return {
      tasks: [],
      tombstones: [],
      source: 'cli',
      note: `Could not read the queue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The Autonomous Queue sidebar: ranked tasks, then tombstones, or one explanatory line. */
export class AutonomousQueueProvider implements vscode.TreeDataProvider<QueueNode> {
  private readonly changed = new vscode.EventEmitter<QueueNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private snapshot: QueueSnapshot | null = null;

  dispose(): void {
    this.changed.dispose();
  }

  refresh(): void {
    this.snapshot = null;
    this.changed.fire(undefined);
  }

  getTreeItem(node: QueueNode): vscode.TreeItem {
    if (node.kind === 'action') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = {
        command: node.command,
        title: node.label,
      };
      return item;
    }
    if (node.kind === 'task') {
      const t = node.task;
      const item = new vscode.TreeItem(
        `${t.id} · ${t.priorityScore.toFixed(1)}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = `${t.status} · ${t.collector}`;
      item.tooltip = t.title || t.description || t.id;
      item.contextValue = 'autonomousTask';
      item.command = {
        command: 'omnexx.showQueueDiff',
        title: 'Show diff',
        arguments: [t.id],
      };
      item.iconPath = new vscode.ThemeIcon(
        t.status === 'VERIFYING'
          ? 'eye'
          : t.status === 'IMPLEMENTING' || t.status === 'PLANNING'
            ? 'sync~spin'
            : 'circle-large-outline',
      );
      return item;
    }
    if (node.kind === 'tombstones') {
      const item = new vscode.TreeItem(
        `Tombstones (${String(node.items.length)})`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return item;
    }
    if (node.kind === 'tombstone') {
      const item = new vscode.TreeItem(node.item.fingerprint, vscode.TreeItemCollapsibleState.None);
      item.description = `strikes ${String(node.item.strikeCount)}${node.item.cooldownUntilMs === -1 ? ' · permanent' : ` · until ${new Date(node.item.cooldownUntilMs).toISOString()}`}`;
      item.tooltip = node.item.failureReason || node.item.failureStage;
      return item;
    }
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  async getChildren(node?: QueueNode): Promise<QueueNode[]> {
    if (node?.kind === 'tombstones') return node.items.map((item) => ({ kind: 'tombstone', item }));
    if (node) return [];
    const folder = primaryFolder();
    const running = await daemonStatus(folder);
    this.snapshot ??= await readAutonomousQueue(folder);
    const snap = this.snapshot;
    const children: QueueNode[] = [];
    children.push({
      kind: 'action',
      label: running ? 'Stop 24/7 Daemon' : 'Start 24/7 Daemon',
      description: running ? 'Running · Click to Stop' : 'Click to Start',
      tooltip: running
        ? 'Click to stop the 24/7 autonomous daemon'
        : 'Click to start 24/7 autonomous daemon on this repository',
      icon: running ? 'debug-stop' : 'play',
      command: 'omnexx.toggleAutonomousDaemon',
    });
    if (snap.note) children.push({ kind: 'message', text: snap.note });
    if (snap.tasks.length === 0 && !snap.note)
      children.push({ kind: 'message', text: 'Queue is empty.' });
    for (const task of snap.tasks) children.push({ kind: 'task', task });
    if (snap.tombstones.length > 0) children.push({ kind: 'tombstones', items: snap.tombstones });
    return children;
  }
}
