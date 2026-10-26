import pc from 'picocolors';
import { formatDuration } from '../../config/duration.js';
import { STALE_AFTER_MS } from '../../core/heartbeat.js';
import { pidAlive, readLock } from '../../core/lock.js';
import { resolvePaths, worktreesDir } from '../../core/paths.js';
import { readChildren } from '../../core/process-registry.js';
import { listRunIds, RunStore } from '../../core/run-store.js';
import { listWorktrees } from '../../git/worktree.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import { supervisorAlive } from './control.js';

export interface PsSupervisor {
  runId: string;
  pid?: number | undefined;
  ageMs: number;
  phase: string;
  status: string;
  heartbeatAgeMs?: number | undefined;
  heartbeatStale?: boolean | undefined;
}

export interface PsServer {
  runId: string;
  pid: number;
  port?: number | undefined;
  url?: string | undefined;
  command: string;
  ageMs: number;
  alive: boolean;
}

export interface PsWorktree {
  path: string;
  runId?: string | undefined;
  ageMs: number;
}

/** Everything `omnexx ps` reports, in one place for the JSON and human renderers. */
export async function psData(now: number, env: NodeJS.ProcessEnv) {
  const paths = resolvePaths(env);
  const ids = await listRunIds(paths);
  const supervisors: PsSupervisor[] = [];
  const servers: PsServer[] = [];
  for (const id of ids) {
    const store = new RunStore(paths, id);
    const state = await store.readState().catch(() => undefined);
    if (!state) continue;
    const [alive, lock, hb] = await Promise.all([
      supervisorAlive(store),
      readLock(store.dir),
      store.readHeartbeat().catch(() => undefined),
    ]);
    if (alive)
      supervisors.push({
        runId: id,
        ...(lock ? { pid: lock.pid } : {}),
        ageMs: now - state.startedAt,
        phase: hb?.phase ?? state.phase,
        status: state.status,
        ...(hb
          ? { heartbeatAgeMs: now - hb.ts, heartbeatStale: now - hb.ts > STALE_AFTER_MS }
          : {}),
      });
    for (const c of readChildren(paths, id)) {
      if (c.kind !== 'server') continue;
      servers.push({
        runId: id,
        pid: c.pid,
        ...(c.port !== undefined ? { port: c.port, url: `http://localhost:${c.port}` } : {}),
        command: c.command,
        ageMs: now - c.startedAt,
        alive: pidAlive(c.pid),
      });
    }
  }
  const worktrees: PsWorktree[] = [];
  for (const w of await listWorktrees(worktreesDir(paths))) {
    let startedAt: number | undefined;
    if (w.runId) {
      const s = await new RunStore(paths, w.runId).readState().catch(() => undefined);
      startedAt = s?.startedAt;
    }
    worktrees.push({
      path: w.path,
      ...(w.runId ? { runId: w.runId } : {}),
      ageMs: now - (startedAt ?? w.mtimeMs),
    });
  }
  return { supervisors, servers, worktrees };
}

export async function psCommand(io: CliIO, json = false): Promise<number> {
  const d = await psData(Date.now(), io.env);
  if (json) {
    println(io.stdout, JSON.stringify(d, null, 2));
    return EXIT.ok;
  }
  if (!d.supervisors.length && !d.servers.length && !d.worktrees.length) {
    println(io.stdout, 'nothing running: no supervisors, servers or worktrees');
    return EXIT.ok;
  }
  if (d.supervisors.length) {
    println(io.stdout, pc.bold('Supervisors'));
    for (const s of d.supervisors)
      println(
        io.stdout,
        `  ${s.runId}  pid ${s.pid ?? '?'}  ${s.status} / ${s.phase}  age ${formatDuration(s.ageMs)}${s.heartbeatAgeMs !== undefined ? `  heartbeat ${formatDuration(s.heartbeatAgeMs)} ago${s.heartbeatStale ? pc.yellow(' (stale)') : ''}` : ''}`,
      );
  }
  if (d.servers.length) {
    println(io.stdout, pc.bold('Dev servers'));
    for (const s of d.servers)
      println(
        io.stdout,
        `  ${s.url ?? `(pid ${s.pid})`}  ${s.alive ? '' : pc.yellow('(dead) ')}${s.command}  [${s.runId}, pid ${s.pid}, age ${formatDuration(s.ageMs)}]`,
      );
  }
  if (d.worktrees.length) {
    println(io.stdout, pc.bold('Worktrees'));
    for (const w of d.worktrees)
      println(
        io.stdout,
        `  ${w.path}${w.runId ? `  [${w.runId}]` : ''}  age ${formatDuration(w.ageMs)}`,
      );
  }
  return EXIT.ok;
}
