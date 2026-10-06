import pc from 'picocolors';
import type { ConfigInput } from '../../config/schema.js';
import { readTextOr } from '../../core/atomic.js';
import { pidAlive, readLock } from '../../core/lock.js';
import { listRunIds, RunStore, TERMINAL } from '../../core/run-store.js';
import { resolvePaths, type OmnexxPaths } from '../../core/paths.js';
import { supervise, type SuperviseOptions } from '../../core/supervisor.js';
import { selfEntry, spawnDetached } from '../../daemon/detach.js';
import { resumeAll } from '../../daemon/resume-all.js';
import { UsageError } from '../../errors.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import { resolveRunDeps } from '../run-deps.js';

/** Explicit run id, or the most recent run. */
export async function pickRun(paths: OmnexxPaths, runId: string | undefined): Promise<RunStore> {
  const ids = await listRunIds(paths);
  const id = runId ?? ids.at(-1);
  if (!id) throw new UsageError('no runs yet', 'start one with `omnexx run "<goal>"`');
  if (!ids.includes(id)) throw new UsageError(`no run ${id}`, '`omnexx runs` lists them');
  return new RunStore(paths, id);
}

export async function supervisorAlive(store: RunStore): Promise<boolean> {
  const lock = await readLock(store.dir);
  return lock !== undefined && pidAlive(lock.pid);
}

/** Foreground supervisor with signal handling: SIGTERM = graceful stop; SIGINT = pause, twice = stop. */
/** The run's command-line overrides, kept so every supervisor start (detach, resume) applies them. */
export const RUN_FLAGS_FILE = 'flags.json';

export async function superviseForeground(
  io: CliIO,
  runId: string,
  opts: SuperviseOptions = io.supervise ?? {},
  /** Runs before the outcome is printed (the live feed flushes and clears its footer). */
  beforeReport?: () => Promise<void>,
): Promise<number> {
  const paths = resolvePaths(io.env);
  const store = new RunStore(paths, runId);
  const state = await store.readState();
  // Flags given to `omnexx run` (budget, gates, models…) outrank omnexx.toml for the whole run.
  const flags = JSON.parse(await readTextOr(store.file(RUN_FLAGS_FILE), '{}')) as ConfigInput;
  const { deps } = await resolveRunDeps(io, state.repoRoot, flags, io.hooks);
  let interrupts = 0;
  const onTerm = (): void => {
    void store.writeControl({ request: 'stop', at: Date.now() });
  };
  const onInt = (): void => {
    interrupts++;
    void store.writeControl({ request: interrupts === 1 ? 'pause' : 'stop', at: Date.now() });
    println(
      io.stderr,
      interrupts === 1
        ? 'pausing at the next turn; Ctrl-C again to stop, `omnexx resume` to continue'
        : 'stopping at the next turn',
    );
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    const out = await supervise(deps, runId, opts);
    await beforeReport?.();
    println(io.stdout, `${pc.bold(out.status)}: ${out.reason}`);
    println(io.stdout, `Report: ${store.file('REPORT.md')}`);
    return out.exitCode;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}

export async function requestControl(
  io: CliIO,
  runId: string | undefined,
  request: 'pause' | 'stop' | 'stop-now',
): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  await store.writeControl({ request, at: Date.now() });
  const alive = await supervisorAlive(store);
  println(
    io.stdout,
    `${request} requested for ${store.runId}${alive ? '' : ' (no supervisor is running; it takes effect when the run resumes)'}`,
  );
  return EXIT.ok;
}

/** Clear a pause; if no supervisor is alive, start one detached (crash, budget raised, user resumed). */
export async function resumeRun(io: CliIO, runId: string | undefined): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  const state = await store.readState();
  await store.writeControl({ request: 'resume', at: Date.now() });
  if (await supervisorAlive(store)) {
    println(io.stdout, `resumed ${store.runId}`);
    return EXIT.ok;
  }
  if (state.status === 'finished')
    throw new UsageError(`${store.runId} already finished`, 'start a new run with `omnexx run`');
  const pid = spawnDetached(
    io.entry ?? selfEntry(),
    ['supervise', store.runId],
    store.file('supervisor.log'),
    io.env,
  );
  println(
    io.stdout,
    `started a supervisor for ${store.runId} (pid ${pid}); follow it with \`omnexx logs -f ${store.runId}\``,
  );
  return EXIT.ok;
}

export async function resumeAllCommand(io: CliIO): Promise<number> {
  return resumeAll(resolvePaths(io.env), io.entry ?? selfEntry(), io.env, (l) => {
    println(io.stdout, l);
  });
}

export const isTerminal = (status: string): boolean =>
  (TERMINAL as readonly string[]).includes(status);
