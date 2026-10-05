import { readLock, pidAlive } from '../core/lock.js';
import type { OmnexxPaths } from '../core/paths.js';
import { listRunIds, RunStore, type RunStatus } from '../core/run-store.js';
import { spawnAttached } from './detach.js';

/** Statuses a boot-time resume picks up on its own. Stops that need a human stay stopped. */
export const AUTO_RESUME: readonly RunStatus[] = ['running', 'paused', 'error'];

export async function resumableRuns(paths: OmnexxPaths): Promise<string[]> {
  const out: string[] = [];
  for (const id of await listRunIds(paths)) {
    const store = new RunStore(paths, id);
    let status: RunStatus;
    try {
      status = (await store.readState()).status;
    } catch {
      continue;
    }
    if (!AUTO_RESUME.includes(status)) continue;
    const lock = await readLock(store.dir);
    if (lock && pidAlive(lock.pid)) continue;
    out.push(id);
  }
  return out;
}

/**
 * `omnexx resume --all`, the entrypoint the systemd unit and launchd agent run: one attached
 * supervisor per resumable run. Stays in the foreground so the service manager sees the process
 * tree; exits non-zero if any supervisor failed, so `Restart=on-failure` retries.
 */
export async function resumeAll(
  paths: OmnexxPaths,
  entry: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<number> {
  const ids = await resumableRuns(paths);
  if (!ids.length) {
    log('nothing to resume');
    return 0;
  }
  log(`resuming ${ids.join(', ')}`);
  const codes = await Promise.all(
    ids.map((id) =>
      spawnAttached(entry, ['supervise', id], new RunStore(paths, id).file('supervisor.log'), env),
    ),
  );
  const failed = codes.filter((c) => c === 1 || c >= 128).length;
  log(`supervisors exited: ${codes.join(', ')}`);
  return failed ? 1 : 0;
}
