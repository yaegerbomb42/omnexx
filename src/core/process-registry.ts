import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readLock } from './lock.js';
import { runDir, type OmnexxPaths } from './paths.js';
import { listRunIds, RunStore } from './run-store.js';

/**
 * Per-run ownership of child processes that can outlive a turn: persistent shells, dev servers,
 * background tasks, daemons. The supervisor keeps an in-memory mirror, but the on-disk file
 * (`~/.omnexx/runs/<runId>/children.json`) is the source of truth, so a reaper can kill a
 * crashed run's children from another process. Entries are removed when the child exits cleanly.
 *
 * A child is killed by its process GROUP (`pgid`), never by the supervisor's own group: a
 * non-detached child (post-edit daemon, MCP stdio server) shares the supervisor's group, so it
 * is registered with `pgid = pid` and the group kill falls through to a direct kill of the pid.
 */

export type ChildKind = 'shell' | 'server' | 'task' | 'worker' | 'daemon';

export interface ChildEntry {
  pid: number;
  pgid: number;
  kind: ChildKind;
  command: string;
  port?: number | undefined;
  startedAt: number;
}

export interface KillResult {
  killed: number;
  survivors: number;
}

const CHILDREN_FILE = 'children.json';

/** The run the current process is supervising, if any. Set by supervise(), cleared on exit. */
let bound: { paths: OmnexxPaths; runId: string } | undefined;

export function bindRun(paths: OmnexxPaths, runId: string): void {
  bound = { paths, runId };
  childrenByRun.set(runId, new Map(readChildren(paths, runId).map((e) => [e.pid, e])));
}

export function unbindRun(): void {
  if (bound) childrenByRun.delete(bound.runId);
  bound = undefined;
}

/** In-memory mirror of the registry for the bound run (disk stays the source of truth). */
const childrenByRun = new Map<string, Map<number, ChildEntry>>();

export function childrenFile(paths: OmnexxPaths, runId: string): string {
  return join(runDir(paths, runId), CHILDREN_FILE);
}

export function readChildren(paths: OmnexxPaths, runId: string): ChildEntry[] {
  try {
    const raw = JSON.parse(readFileSync(childrenFile(paths, runId), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is ChildEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as ChildEntry).pid === 'number' &&
        typeof (e as ChildEntry).pgid === 'number' &&
        typeof (e as ChildEntry).command === 'string',
    );
  } catch {
    return [];
  }
}

function writeChildren(paths: OmnexxPaths, runId: string, entries: ChildEntry[]): void {
  try {
    const dir = runDir(paths, runId);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${CHILDREN_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, `${JSON.stringify(entries)}\n`, 'utf8');
    renameSync(tmp, childrenFile(paths, runId));
  } catch {
    // Registration is best effort: a run must never fail because its registry is unwritable.
  }
}

/**
 * Register a child process. `runId` defaults to the run bound by supervise(); with neither, this
 * is a no-op (one-off CLI invocations and tests that spawn without a run).
 */
export function registerChild(
  entry: Omit<ChildEntry, 'startedAt'> & { startedAt?: number },
  runId?: string,
): void {
  const id = runId ?? bound?.runId;
  const paths = bound?.paths;
  if (!id || !paths) return;
  const full: ChildEntry = { ...entry, startedAt: entry.startedAt ?? Date.now() };
  let map = childrenByRun.get(id);
  if (!map) {
    map = new Map(readChildren(paths, id).map((e) => [e.pid, e]));
    childrenByRun.set(id, map);
  }
  map.set(full.pid, full);
  writeChildren(paths, id, [...map.values()]);
}

export function unregisterChild(pid: number, runId?: string): void {
  const id = runId ?? bound?.runId;
  const paths = bound?.paths;
  if (!id || !paths) return;
  childrenByRun.get(id)?.delete(pid);
  writeChildren(
    paths,
    id,
    readChildren(paths, id).filter((e) => e.pid !== pid),
  );
}

/** SIGTERM a process group (falling back to the bare pid), tolerating "already gone". */
function termEntry(entry: ChildEntry): void {
  try {
    process.kill(-entry.pgid, 'SIGTERM');
  } catch {
    // No such group (a non-detached child is not a group leader): fall through to the pid.
  }
  if (pidAlive(entry.pid)) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

function killEntry(entry: ChildEntry): void {
  try {
    process.kill(-entry.pgid, 'SIGKILL');
  } catch {
    // no such group
  }
  if (pidAlive(entry.pid)) {
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * SIGTERM every registered child of `runId` (by process group), wait up to `graceMs` in total,
 * then SIGKILL the survivors. Entries for children that died are dropped; survivors stay
 * registered so a later reap can retry them. Never throws.
 */
export async function killRunChildren(
  paths: OmnexxPaths,
  runId: string,
  opts: { graceMs?: number } = {},
): Promise<KillResult> {
  const graceMs = opts.graceMs ?? 5_000;
  let entries: ChildEntry[];
  try {
    entries = readChildren(paths, runId);
  } catch {
    return { killed: 0, survivors: 0 };
  }
  if (!entries.length) return { killed: 0, survivors: 0 };
  for (const e of entries) termEntry(e);
  const deadline = Date.now() + graceMs;
  for (;;) {
    const alive = entries.filter((e) => pidAlive(e.pid));
    if (!alive.length) break;
    if (Date.now() >= deadline) {
      for (const e of alive) killEntry(e);
      break;
    }
    await sleep(100);
  }
  // Give the SIGKILL a moment to land before reporting.
  await sleep(100);
  const survivors = entries.filter((e) => pidAlive(e.pid));
  try {
    writeChildren(paths, runId, survivors);
    if (bound?.runId === runId) {
      const map = childrenByRun.get(runId);
      if (map) for (const e of entries) if (!survivors.includes(e)) map.delete(e.pid);
    }
  } catch {
    // best effort
  }
  return { killed: entries.length - survivors.length, survivors: survivors.length };
}

/** SIGTERM one pid, then SIGKILL after `graceMs` if it is still alive. Never throws. */
export async function killPid(pid: number, opts: { graceMs?: number } = {}): Promise<boolean> {
  const graceMs = opts.graceMs ?? 5_000;
  if (!pidAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(100);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    await sleep(100);
  }
  return !pidAlive(pid);
}

export interface ReapResult {
  reapedSupervisors: string[];
  reapedChildren: string[];
}

/**
 * Kill supervisors that stopped beating and orphaned children of runs with no supervisor.
 * A supervisor is only reaped when its heartbeat is older than `staleMs` AND its pid is still
 * alive AND it still holds the run's lock (a fresh heartbeat is never touched, and a lock held
 * by a different pid means a newer supervisor took over). Children of a run with no live
 * supervisor are always orphans and are killed. Best effort; never throws; stops scanning
 * after `maxMs` so a CLI invocation is never held up for long.
 */
export async function reapStaleSupervisors(
  paths: OmnexxPaths,
  opts: {
    staleMs?: number;
    graceMs?: number;
    maxMs?: number;
    log?: (line: string) => void;
  } = {},
): Promise<ReapResult> {
  const staleMs = opts.staleMs ?? 30 * 60_000;
  const graceMs = opts.graceMs ?? 5_000;
  const maxMs = opts.maxMs ?? 8_000;
  const started = Date.now();
  const out: ReapResult = { reapedSupervisors: [], reapedChildren: [] };
  let ids: string[];
  try {
    ids = await listRunIds(paths);
  } catch {
    return out;
  }
  for (const id of ids) {
    if (Date.now() - started > maxMs) break;
    try {
      const store = new RunStore(paths, id);
      const [hb, lock] = await Promise.all([
        store.readHeartbeat().catch(() => undefined),
        readLock(store.dir),
      ]);
      const children = readChildren(paths, id);
      if (lock !== undefined && lock.pid !== process.pid && pidAlive(lock.pid)) {
        const stale = hb?.pid === lock.pid && Date.now() - hb.ts > staleMs;
        if (!stale) continue;
        const ageS = Math.round((Date.now() - hb.ts) / 1_000);
        await killPid(lock.pid, { graceMs });
        const killed = await killRunChildren(paths, id, { graceMs });
        out.reapedSupervisors.push(id);
        if (killed.killed > 0) out.reapedChildren.push(id);
        opts.log?.(
          `reaped stale supervisor for ${id} (pid ${lock.pid}, heartbeat ${ageS}s old); killed ${killed.killed} child process(es)`,
        );
      } else if (children.length > 0) {
        const killed = await killRunChildren(paths, id, { graceMs });
        if (killed.killed > 0) {
          out.reapedChildren.push(id);
          opts.log?.(
            `reaped ${killed.killed} orphaned child process(es) of ${id} (no supervisor running)`,
          );
        }
      }
    } catch {
      // One unreadable run must not stop the sweep.
    }
  }
  return out;
}

export function removeChildrenFile(paths: OmnexxPaths, runId: string): void {
  try {
    rmSync(childrenFile(paths, runId), { force: true });
  } catch {
    // best effort
  }
}
