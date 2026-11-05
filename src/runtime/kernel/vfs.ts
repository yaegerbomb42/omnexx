import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * In-memory virtual filesystem overlay for non-git workspaces (and as a supplement
 * when git status is empty). Tracks every path the kernel has observed so checkpoints
 * can snapshot/restore without relying on `git status`.
 */
export class MemoryVfs {
  private readonly root: string;
  /** Relative path → content. `null` means the path is known-absent (deleted). */
  private readonly files = new Map<string, string | null>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  get size(): number {
    return this.files.size;
  }

  /** Record that a path currently holds `content` (or is absent when null). */
  touch(path: string, content: string | null): void {
    const rel = this.rel(path);
    if (!rel) return;
    this.files.set(rel, content);
  }

  /** Read from disk into the VFS (best-effort) and return the content. */
  async ingest(path: string): Promise<string | null> {
    const rel = this.rel(path);
    if (!rel) return null;
    try {
      const content = await readFile(join(this.root, rel), 'utf8');
      this.files.set(rel, content);
      return content;
    } catch {
      this.files.set(rel, null);
      return null;
    }
  }

  /** Snapshot of every tracked path (empty string = absent). */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [rel, content] of this.files) {
      out[rel] = content ?? '';
    }
    return out;
  }

  /** Restore a prior snapshot onto disk and into this VFS. */
  async restore(files: Record<string, string>): Promise<string[]> {
    const restored: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(this.root, rel);
      if (content === '') {
        await rm(abs, { force: true }).catch(() => undefined);
        this.files.set(rel, null);
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
        this.files.set(rel, content);
      }
      restored.push(rel);
    }
    return restored;
  }

  /** Merge extra paths from a tool input into the VFS by reading them from disk. */
  async ingestMany(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.ingest(p)));
  }

  keys(): string[] {
    return [...this.files.keys()];
  }

  private rel(path: string): string {
    const abs = resolve(this.root, path);
    const r = relative(this.root, abs);
    if (!r || r.startsWith('..')) return '';
    return r.split('\\').join('/');
  }
}
