import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { git } from '../../git/git.js';
import { isMutatingTool, rollbackConstraint, type CheckpointRecord } from './types.js';

export interface CheckpointOptions {
  worktree: string;
  /** Soft cap on checkpoints kept in memory (oldest dropped). */
  maxCheckpoints?: number | undefined;
}

export interface RollbackResult {
  restored: boolean;
  constraint: string;
  /** Conversation length to keep (messages after this index should be dropped). */
  pruneAfter: number;
  nodeId: string;
  filesRestored: string[];
}

/**
 * Deterministic DAG checkpointer. Snapshots dirty working-tree files + HEAD before
 * mutating tools, restores them on rollback, and supplies the one-line kernel constraint.
 */
export class StateCheckpointer {
  private readonly worktree: string;
  private readonly maxCheckpoints: number;
  private readonly byNode = new Map<string, CheckpointRecord>();
  private order: string[] = [];

  constructor(options: CheckpointOptions) {
    this.worktree = resolve(options.worktree);
    this.maxCheckpoints = options.maxCheckpoints ?? 32;
  }

  get size(): number {
    return this.byNode.size;
  }

  has(nodeId: string): boolean {
    return this.byNode.has(nodeId);
  }

  get(nodeId: string): CheckpointRecord | undefined {
    return this.byNode.get(nodeId);
  }

  /** Whether this tool call should be preceded by a snapshot. */
  shouldSnapshot(toolName: string): boolean {
    return isMutatingTool(toolName);
  }

  /**
   * Snapshot HEAD + contents of dirty paths (and optional explicit paths from the tool input).
   * Uses `git status --porcelain` when available; falls back to the explicit path list.
   */
  async snapshot(
    nodeId: string,
    conversationLength: number,
    extraPaths: readonly string[] = [],
  ): Promise<CheckpointRecord> {
    const headSha = await this.headSha();
    const dirty = await this.dirtyPaths();
    const paths = new Set<string>([
      ...dirty,
      ...extraPaths.map((p) => this.rel(p)).filter(Boolean),
    ]);
    const files: Record<string, string> = {};
    for (const rel of paths) {
      files[rel] = await this.readRel(rel);
    }
    const record: CheckpointRecord = {
      nodeId,
      headSha,
      files,
      createdAt: Date.now(),
      conversationLength,
    };
    this.byNode.set(nodeId, record);
    this.order = this.order.filter((id) => id !== nodeId);
    this.order.push(nodeId);
    while (this.order.length > this.maxCheckpoints) {
      const drop = this.order.shift();
      if (drop) this.byNode.delete(drop);
    }
    return record;
  }

  /**
   * Restore filesystem to the checkpoint, prune conversation after it, inject constraint.
   */
  async rollbackToCheckpoint(nodeId: string, negativeConstraint: string): Promise<RollbackResult> {
    const record = this.byNode.get(nodeId);
    if (!record) {
      return {
        restored: false,
        constraint: rollbackConstraint(nodeId, negativeConstraint, 'a different approach'),
        pruneAfter: 0,
        nodeId,
        filesRestored: [],
      };
    }

    const restored: string[] = [];
    for (const [rel, content] of Object.entries(record.files)) {
      const abs = join(this.worktree, rel);
      if (content === '') {
        await rm(abs, { force: true }).catch(() => undefined);
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
      }
      restored.push(rel);
    }

    // Drop this node and every checkpoint taken after it (failed branch).
    const idx = this.order.indexOf(nodeId);
    if (idx >= 0) {
      for (const id of this.order.slice(idx)) this.byNode.delete(id);
      this.order = this.order.slice(0, idx);
    }

    return {
      restored: true,
      constraint: rollbackConstraint(nodeId, negativeConstraint, 'a different approach'),
      pruneAfter: record.conversationLength,
      nodeId,
      filesRestored: restored,
    };
  }

  private rel(path: string): string {
    const abs = resolve(this.worktree, path);
    const r = relative(this.worktree, abs);
    if (!r || r.startsWith('..')) return '';
    return r.split('\\').join('/');
  }

  private async readRel(rel: string): Promise<string> {
    try {
      return await readFile(join(this.worktree, rel), 'utf8');
    } catch {
      return '';
    }
  }

  private async headSha(): Promise<string> {
    const r = await git(this.worktree, ['rev-parse', 'HEAD'], { allowFailure: true });
    return r.exitCode === 0 ? r.stdout.trim() : 'NOGIT';
  }

  private async dirtyPaths(): Promise<string[]> {
    const r = await git(this.worktree, ['status', '--porcelain', '-uall'], { allowFailure: true });
    if (r.exitCode !== 0) return [];
    const out: string[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      // "XY path" or "XY orig -> path" for renames
      const pathPart = line.slice(3);
      const arrow = pathPart.lastIndexOf(' -> ');
      const raw = arrow >= 0 ? pathPart.slice(arrow + 4) : pathPart;
      const cleaned = raw.replace(/^"|"$/g, '').trim();
      if (cleaned) out.push(cleaned.split('\\').join('/'));
    }
    return out;
  }
}

/** Paths mentioned in a mutating tool's input, for targeted snapshots. */
export function pathsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  if (typeof o.path === 'string') out.push(o.path);
  if (typeof o.file_path === 'string') out.push(o.file_path);
  if (Array.isArray(o.files)) {
    for (const f of o.files) {
      if (typeof f === 'string') out.push(f);
      else if (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string') {
        out.push((f as { path: string }).path);
      }
    }
  }
  if (Array.isArray(o.edits)) {
    for (const e of o.edits) {
      if (e && typeof e === 'object' && typeof (e as { path?: unknown }).path === 'string') {
        out.push((e as { path: string }).path);
      }
    }
  }
  return out;
}
