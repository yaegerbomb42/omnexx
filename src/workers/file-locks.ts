/**
 * Region locks: the swarm's answer to two subagents editing the same lines at once. A lock
 * covers line regions of files (not whole files), so parallel workers can touch different
 * parts of one file but never overlapping ranges. Regions conflict exactly when they name the
 * same path and their inclusive line ranges intersect.
 *
 * Fairness is FIFO per file: a queued waiter blocks later arrivals whose regions conflict with
 * it, even if the later arrival conflicts with nothing currently held — otherwise a stream of
 * small edits could starve a big one forever. Waiters that conflict with nothing ahead of them
 * are granted out of order, so unrelated files never queue behind each other. A lock may carry
 * a TTL as a backstop against a dead owner. Expiry is enforced on acquire/snapshot and by one
 * unref'd timer armed for the earliest expiresAt, so a waiter queued behind a dead owner's lock
 * is woken at expiry instead of idling out its own timeoutMs. The timer is unref'd, so it never
 * keeps a process alive on its own.
 *
 * Not re-entrant: an owner that already holds a region conflicts with itself and must release
 * first. That is deliberate — silent re-entry hides exactly the coordination bugs this exists
 * to catch.
 */
import { LockError } from '../errors.js';

/** One locked span of one file. Lines are inclusive at both ends. */
export interface FileRegion {
  path: string;
  startLine: number;
  endLine: number;
}

/** A region spanning a whole file, for specs that do not name line ranges. */
export function wholeFileRegion(path: string): FileRegion {
  return { path, startLine: 1, endLine: Number.MAX_SAFE_INTEGER };
}

/** True when the regions name the same file and their inclusive ranges share a line. */
export function regionsConflict(a: FileRegion, b: FileRegion): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** acquire() waited past its timeout: the conflicting holder did not finish in time. */
export class LockTimeoutError extends LockError {
  readonly ownerId: string;
  readonly regions: readonly FileRegion[];
  readonly timeoutMs: number;

  constructor(ownerId: string, regions: readonly FileRegion[], timeoutMs: number) {
    super(
      `region lock for ${ownerId} timed out after ${timeoutMs}ms`,
      'the conflicting holder is still working; retry or narrow the regions',
    );
    this.ownerId = ownerId;
    this.regions = regions;
    this.timeoutMs = timeoutMs;
  }
}

export interface AcquireOptions {
  /** Max time to wait for conflicting locks; when omitted, waits until granted. */
  timeoutMs?: number;
  /** Backstop expiry for the granted lock, in milliseconds from acquisition. */
  ttlMs?: number;
}

/** A granted lock. release() is idempotent; releasing wakes the waiters it was blocking. */
export interface LockHandle {
  readonly ownerId: string;
  readonly regions: readonly FileRegion[];
  release(): void;
}

/** One held lock, as reported by activeLocks(). */
export interface ActiveLock {
  readonly ownerId: string;
  readonly regions: readonly FileRegion[];
  readonly acquiredAt: number;
  readonly expiresAt: number | undefined;
}

export interface RegionLockManagerOptions {
  /** Clock for acquiredAt/expiry; injectable for deterministic tests. */
  now?: () => number;
}

interface HeldLock {
  ownerId: string;
  regions: FileRegion[];
  acquiredAt: number;
  expiresAt: number | undefined;
}

interface Waiter {
  ownerId: string;
  regions: FileRegion[];
  ttlMs: number | undefined;
  resolve: (handle: LockHandle) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class RegionLockManager {
  private readonly now: () => number;
  private readonly held: HeldLock[] = [];
  private readonly waiters: Waiter[] = [];
  private ttlTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: RegionLockManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Take the regions for ownerId. Grants immediately when nothing held (and no earlier
   * waiter) conflicts; otherwise queues FIFO and resolves on release, or rejects with
   * LockTimeoutError when opts.timeoutMs elapses first.
   */
  async acquire(
    ownerId: string,
    regions: readonly FileRegion[],
    opts: AcquireOptions = {},
  ): Promise<LockHandle> {
    this.pruneExpired();
    const wanted = regions.map((r) => ({ ...r }));
    if (this.canGrant(wanted, this.waiters.length)) return this.grant(ownerId, wanted, opts.ttlMs);
    return new Promise<LockHandle>((resolve, reject) => {
      const waiter: Waiter = {
        ownerId,
        regions: wanted,
        ttlMs: opts.ttlMs,
        resolve,
        reject,
        timer: undefined,
      };
      const timeoutMs = opts.timeoutMs;
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new LockTimeoutError(ownerId, wanted, timeoutMs));
        }, timeoutMs);
        waiter.timer.unref();
      }
      this.waiters.push(waiter);
    });
  }

  /** acquire → run fn → release, even when fn throws. The shape almost every caller wants. */
  async withLock<T>(
    ownerId: string,
    regions: readonly FileRegion[],
    fn: () => Promise<T> | T,
    opts: AcquireOptions = {},
  ): Promise<T> {
    const handle = await this.acquire(ownerId, regions, opts);
    try {
      return await fn();
    } finally {
      handle.release();
    }
  }

  /** Snapshot of currently held locks (expired ones pruned first). For tests and debugging. */
  activeLocks(): ActiveLock[] {
    this.pruneExpired();
    return this.held.map((h) => ({
      ownerId: h.ownerId,
      regions: h.regions.map((r) => ({ ...r })),
      acquiredAt: h.acquiredAt,
      expiresAt: h.expiresAt,
    }));
  }

  /** Grantable when no held lock conflicts and no waiter ahead of queueIndex conflicts. */
  private canGrant(regions: readonly FileRegion[], queueIndex: number): boolean {
    const hits = (other: readonly FileRegion[]): boolean =>
      regions.some((r) => other.some((o) => regionsConflict(r, o)));
    if (this.held.some((h) => hits(h.regions))) return false;
    return !this.waiters.slice(0, queueIndex).some((w) => hits(w.regions));
  }

  private grant(ownerId: string, regions: FileRegion[], ttlMs: number | undefined): LockHandle {
    const acquiredAt = this.now();
    const lock: HeldLock = {
      ownerId,
      regions,
      acquiredAt,
      expiresAt: ttlMs !== undefined ? acquiredAt + ttlMs : undefined,
    };
    this.held.push(lock);
    this.scheduleExpiry();
    let released = false;
    return {
      ownerId,
      regions,
      release: () => {
        if (released) return;
        released = true;
        const at = this.held.indexOf(lock);
        if (at >= 0) this.held.splice(at, 1);
        this.scheduleExpiry();
        this.wakeWaiters();
      },
    };
  }

  /** Grant every waiter that can now go, front to back, skipping ones still blocked. */
  private wakeWaiters(): void {
    let i = 0;
    while (i < this.waiters.length) {
      const waiter = this.waiters[i];
      if (!waiter || !this.canGrant(waiter.regions, i)) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(this.grant(waiter.ownerId, waiter.regions, waiter.ttlMs));
      // No i++: the next waiter shifted into slot i, and grants above may now block it.
    }
  }

  /** Drop held locks whose TTL has passed, then see who that frees up. */
  private pruneExpired(): void {
    const at = this.now();
    let freed = false;
    for (let i = this.held.length - 1; i >= 0; i--) {
      const lock = this.held[i];
      if (lock?.expiresAt !== undefined && lock.expiresAt <= at) {
        this.held.splice(i, 1);
        freed = true;
      }
    }
    this.scheduleExpiry();
    if (freed) this.wakeWaiters();
  }

  /**
   * Keep exactly one unref'd timer armed for the earliest held expiresAt. The timer's job is
   * narrow: a waiter queued behind a TTL lock has no acquire() of its own to prune that lock
   * (the only call sites before this), so without it the waiter idles out its whole timeoutMs.
   * Called after every mutation of held; an empty tick with no TTL locks left arms nothing.
   */
  private scheduleExpiry(): void {
    if (this.ttlTimer !== undefined) clearTimeout(this.ttlTimer);
    this.ttlTimer = undefined;
    let earliest: number | undefined;
    for (const lock of this.held) {
      if (lock.expiresAt === undefined) continue;
      if (earliest === undefined || lock.expiresAt < earliest) earliest = lock.expiresAt;
    }
    if (earliest === undefined) return;
    const delay = Math.max(0, earliest - this.now());
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = undefined;
      this.pruneExpired();
    }, delay);
    this.ttlTimer.unref();
  }
}
