import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { git } from '../../git/git.js';
import { isMutatingTool, rollbackConstraint, type CheckpointRecord } from './types.js';
import { MemoryVfs } from './vfs.js';

export interface CheckpointOptions {
  worktree: string;
  /** Soft cap on checkpoints kept in memory (oldest dropped). */
  maxCheckpoints?: number | undefined;
  /** Optional shared VFS (created automatically when omitted). */
  vfs?: MemoryVfs | undefined;
  /** Files larger than this (or binary) are not snapshotted (default 2 MiB). */
  maxFileBytes?: number | undefined;
}

/** Default per-file snapshot ceiling; bigger/binary files can't be restored from memory. */
export const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;

export interface RollbackResult {
  restored: boolean;
  constraint: string;
  /** Conversation length to keep (messages after this index should be dropped). */
  pruneAfter: number;
  nodeId: string;
  filesRestored: string[];
  /** True when the snapshot came from the in-memory VFS rather than git status. */
  usedVfs: boolean;
  /** Paths that were too large/binary to snapshot and therefore were NOT restored. */
  skipped: string[];
}

/**
 * Deterministic DAG checkpointer. Prefers git dirty-file discovery; when git is
 * unavailable or reports nothing, falls back to the in-memory VFS of touched paths.
 */
export class StateCheckpointer {
  private readonly worktree: string;
  private readonly maxCheckpoints: number;
  readonly vfs: MemoryVfs;
  private readonly maxFileBytes: number;
  private readonly byNode = new Map<
    string,
    CheckpointRecord & { usedVfs: boolean; skipped: string[] }
  >();
  private order: string[] = [];
  private gitAvailable: boolean | undefined;

  constructor(options: CheckpointOptions) {
    this.worktree = resolve(options.worktree);
    this.maxCheckpoints = options.maxCheckpoints ?? 32;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_SNAPSHOT_FILE_BYTES;
    this.vfs = options.vfs ?? new MemoryVfs(this.worktree);
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

  shouldSnapshot(toolName: string): boolean {
    return isMutatingTool(toolName);
  }

  /** Record a path the agent touched so non-git rollbacks still work. */
  async notePath(path: string): Promise<void> {
    await this.vfs.ingest(path);
  }

  async snapshot(
    nodeId: string,
    conversationLength: number,
    extraPaths: readonly string[] = [],
  ): Promise<CheckpointRecord & { usedVfs: boolean; skipped: string[] }> {
    await this.vfs.ingestMany(extraPaths);
    const headSha = await this.headSha();
    const dirty = await this.dirtyPaths();
    let usedVfs = false;
    const paths = new Set<string>([
      ...dirty,
      ...extraPaths.map((p) => this.rel(p)).filter(Boolean),
    ]);

    // Non-git / empty-status fallback: snapshot everything the VFS has seen.
    if (paths.size === 0 || headSha === 'NOGIT') {
      usedVfs = true;
      for (const k of this.vfs.keys()) paths.add(k);
      for (const p of extraPaths) {
        const r = this.rel(p);
        if (r) paths.add(r);
      }
    }

    const files: Record<string, string> = {};
    const skipped: string[] = [];
    for (const rel of paths) {
      if (!(await this.snapshottable(rel))) {
        skipped.push(rel);
        continue;
      }
      files[rel] = await this.readRel(rel);
      this.vfs.touch(rel, files[rel] === '' ? null : files[rel]);
    }
    // Always merge current VFS snapshot so previously touched-but-clean files are covered.
    if (usedVfs) {
      const vfsFiles = this.vfs.snapshot();
      for (const rel of skipped) Reflect.deleteProperty(vfsFiles, rel);
      Object.assign(files, vfsFiles);
    }

    const record = {
      nodeId,
      headSha,
      files,
      createdAt: Date.now(),
      conversationLength,
      usedVfs,
      skipped,
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

  async rollbackToCheckpoint(nodeId: string, negativeConstraint: string): Promise<RollbackResult> {
    const record = this.byNode.get(nodeId);
    if (!record) {
      return {
        restored: false,
        constraint: rollbackConstraint(nodeId, negativeConstraint, 'a different approach'),
        pruneAfter: 0,
        nodeId,
        filesRestored: [],
        usedVfs: false,
        skipped: [],
      };
    }

    const restored = await this.vfs.restore(record.files);
    // Also write via direct FS for paths the VFS restore already handled — restore() covers disk.

    const idx = this.order.indexOf(nodeId);
    if (idx >= 0) {
      for (const id of this.order.slice(idx)) this.byNode.delete(id);
      this.order = this.order.slice(0, idx);
    }

    const skippedNote = record.skipped.length
      ? ` [not restored (too large/binary): ${record.skipped.slice(0, 5).join(', ')}${record.skipped.length > 5 ? ', …' : ''}]`
      : '';
    return {
      restored: true,
      constraint:
        rollbackConstraint(nodeId, negativeConstraint, 'a different approach') + skippedNote,
      pruneAfter: record.conversationLength,
      nodeId,
      filesRestored: restored,
      usedVfs: record.usedVfs,
      skipped: record.skipped,
    };
  }

  private rel(path: string): string {
    const abs = resolve(this.worktree, path);
    const r = relative(this.worktree, abs);
    if (!r || r.startsWith('..')) return '';
    return r.split('\\').join('/');
  }

  /** Missing files are snapshottable (absent); oversized or binary files are not. */
  private async snapshottable(rel: string): Promise<boolean> {
    const abs = join(this.worktree, rel);
    try {
      const st = await stat(abs);
      if (!st.isFile()) return false;
      if (st.size > this.maxFileBytes) return false;
      const head = (await readFile(abs)).subarray(0, 8000);
      return !head.includes(0);
    } catch {
      return true;
    }
  }

  private async readRel(rel: string): Promise<string> {
    try {
      return await readFile(join(this.worktree, rel), 'utf8');
    } catch {
      return '';
    }
  }

  private async headSha(): Promise<string> {
    if (this.gitAvailable === false) return 'NOGIT';
    const r = await git(this.worktree, ['rev-parse', 'HEAD'], { allowFailure: true });
    this.gitAvailable = r.exitCode === 0;
    return r.exitCode === 0 ? r.stdout.trim() : 'NOGIT';
  }

  private async dirtyPaths(): Promise<string[]> {
    if (this.gitAvailable === false) return [];
    const r = await git(this.worktree, ['status', '--porcelain', '-uall'], { allowFailure: true });
    if (r.exitCode !== 0) {
      this.gitAvailable = false;
      return [];
    }
    this.gitAvailable = true;
    const out: string[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const pathPart = line.slice(3);
      const arrow = pathPart.lastIndexOf(' -> ');
      const raw = arrow >= 0 ? pathPart.slice(arrow + 4) : pathPart;
      const cleaned = raw.replace(/^"|"$/g, '').trim();
      if (cleaned) out.push(cleaned.split('\\').join('/'));
    }
    return out;
  }
}

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
