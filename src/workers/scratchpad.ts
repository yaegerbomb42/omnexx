/**
 * The swarm's shared board: one in-memory scratchpad the parent agent and its workers all read
 * and write, so a phase never has to re-derive what an earlier phase learned. Entries are
 * namespaced (one namespace per concern, e.g. "spec", "impl") so workers cannot collide by
 * accident; writes are versioned so a worker can claim an entry with optimistic concurrency
 * instead of locking the board; and an append-only event log keeps the durable history of what
 * happened, in order. Live subscribers see mutations as they happen; the log is written only
 * through append(), so callers decide what is history and what is just state.
 *
 * Purely in-memory and synchronous: a scratchpad lives for one coordinator run, never touches
 * disk, and is safe to share because every operation completes before another can start.
 */
import { StateError } from '../errors.js';

/** One stored value plus its write version (1 for the first write) and last-write time. */
export interface ScratchpadEntry {
  readonly value: unknown;
  readonly version: number;
  readonly updatedAt: number;
}

/** What a caller hands to append(): what happened, where, and an optional human note. */
export interface ScratchpadEventInput {
  ns: string;
  key: string;
  /** Free-form verb for the history: "phase-output", "verdict", "note", ... */
  kind: string;
  note?: string;
}

/** A logged event: the input plus its monotonic sequence number and timestamp. */
export interface ScratchpadEvent extends ScratchpadEventInput {
  readonly seq: number;
  readonly at: number;
}

/** A live mutation, delivered to subscribers synchronously as it happens. */
export type ScratchpadChange =
  | { readonly type: 'put'; readonly ns: string; readonly key: string; readonly version: number }
  | { readonly type: 'delete'; readonly ns: string; readonly key: string }
  | { readonly type: 'append'; readonly event: ScratchpadEvent };

/** putIfVersion lost the race: the entry moved on since the caller read it. */
export class ScratchpadVersionError extends StateError {
  readonly ns: string;
  readonly key: string;
  readonly expected: number;
  readonly actual: number;

  constructor(ns: string, key: string, expected: number, actual: number) {
    super(
      `scratchpad ${ns}/${key} is at version ${actual}, not ${expected}`,
      're-read the entry and retry against its current version',
    );
    this.ns = ns;
    this.key = key;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface SharedScratchpadOptions {
  /** Clock for entry timestamps and log events; injectable for deterministic tests. */
  now?: () => number;
}

/**
 * The board itself. Not thread-safe by design: Node is single-threaded and every method here
 * is synchronous, so interleaving can only happen at a caller's awaits, never mid-operation.
 */
export class SharedScratchpad {
  private readonly now: () => number;
  private readonly store = new Map<string, Map<string, ScratchpadEntry>>();
  private readonly log: ScratchpadEvent[] = [];
  private readonly listeners = new Set<(change: ScratchpadChange) => void>();
  private seq = 0;

  constructor(opts: SharedScratchpadOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Write a value, bumping its version. Returns the new version (1 for a first write). */
  put(ns: string, key: string, value: unknown): number {
    const bucket = this.bucket(ns);
    const version = (bucket.get(key)?.version ?? 0) + 1;
    bucket.set(key, { value, version, updatedAt: this.now() });
    this.emit({ type: 'put', ns, key, version });
    return version;
  }

  /**
   * Write only if the entry is still at expectedVersion (0 means "must not exist yet").
   * The claim primitive: two workers racing to own a key cannot both win.
   */
  putIfVersion(ns: string, key: string, value: unknown, expectedVersion: number): number {
    const actual = this.version(ns, key);
    if (actual !== expectedVersion)
      throw new ScratchpadVersionError(ns, key, expectedVersion, actual);
    return this.put(ns, key, value);
  }

  /**
   * The value at ns/key, or undefined when absent. Values are stored untyped: the namespace
   * owner defines what lives under its keys, and callers narrow at the read site.
   */
  get(ns: string, key: string): unknown {
    return this.store.get(ns)?.get(key)?.value;
  }

  /** The full entry (value, version, timestamp), or undefined when absent. */
  getEntry(ns: string, key: string): ScratchpadEntry | undefined {
    return this.store.get(ns)?.get(key);
  }

  /** Current version of an entry; 0 when it does not exist (including after a delete). */
  version(ns: string, key: string): number {
    return this.store.get(ns)?.get(key)?.version ?? 0;
  }

  /** Keys present in a namespace, in first-write order. Empty for an unknown namespace. */
  list(ns: string): string[] {
    return [...(this.store.get(ns)?.keys() ?? [])];
  }

  /** Remove an entry. Returns whether anything was there. */
  delete(ns: string, key: string): boolean {
    const bucket = this.store.get(ns);
    if (!bucket?.delete(key)) return false;
    this.emit({ type: 'delete', ns, key });
    return true;
  }

  /** Append to the durable log. Sequence numbers start at 1 and never repeat or go back. */
  append(input: ScratchpadEventInput): ScratchpadEvent {
    const event: ScratchpadEvent = { ...input, seq: ++this.seq, at: this.now() };
    this.log.push(event);
    this.emit({ type: 'append', event });
    return event;
  }

  /** Logged events with seq greater than sinceSeq (all of them by default), in order. */
  events(sinceSeq = 0): readonly ScratchpadEvent[] {
    return this.log.filter((e) => e.seq > sinceSeq);
  }

  /** Watch live mutations. Returns the unsubscribe handle; call it to stop listening. */
  subscribe(listener: (change: ScratchpadChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private bucket(ns: string): Map<string, ScratchpadEntry> {
    let bucket = this.store.get(ns);
    if (!bucket) {
      bucket = new Map();
      this.store.set(ns, bucket);
    }
    return bucket;
  }

  private emit(change: ScratchpadChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
