import type { Suite, TaskDef } from '../types.ts';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

/** A private npm cache: a shared one can be unwritable or locked by other tools. */
const NPM_CACHE = join(tmpdir(), 'omnexx-bench-npm-cache');

/**
 * A suite stored as task directories: each holds `setup.sh` (builds the repo), `goal.md` (the
 * prompt), `check.sh` (the hidden acceptance check) and optionally `solution/` (a reference
 * overlay). Only setup's output is visible to the agent.
 */
export class DirSuite implements Suite {
  readonly name: string;
  private readonly root: string;

  // No parameter properties: `node bench/run.ts` runs this file through type stripping.
  constructor(name: string, root: string) {
    this.name = name;
    this.root = root;
  }

  async loadTasks(): Promise<TaskDef[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, 'check.sh')))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return Promise.all(
      dirs.map(async (name) => {
        const goal = await readFile(join(this.root, name, 'goal.md'), 'utf-8').catch(() => '');
        return { id: name, path: name, description: goalTitle(goal) ?? name };
      }),
    );
  }

  async setupTask(task: TaskDef, workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const setup = join(this.root, task.path, 'setup.sh');
    if (existsSync(setup)) {
      const code = await runBash(setup, workDir);
      if (code !== 0) throw new Error(`setup.sh for ${task.id} exited ${code}`);
    }
    // Agents work on a clean, committed repo (omnexx branches its worktree from HEAD).
    const git = `git init -q && git add -A && git -c user.name=bench -c user.email=bench@omnexx.dev commit -qm "bench: ${task.id} start" --allow-empty`;
    const code = await runBash(null, workDir, git);
    if (code !== 0) throw new Error(`git init for ${task.id} exited ${code}`);
  }

  async getGoal(task: TaskDef): Promise<string> {
    try {
      return await readFile(join(this.root, task.path, 'goal.md'), 'utf-8');
    } catch {
      return `Task: ${task.description}`;
    }
  }

  async checkTask(task: TaskDef, workDir: string): Promise<boolean> {
    const check = join(this.root, task.path, 'check.sh');
    if (!existsSync(check)) return false;
    return (await runBash(check, workDir)) === 0;
  }
}

/** The first markdown heading of a goal, without a leading "Task:". */
export function goalTitle(goal: string): string | undefined {
  const heading = goal.split('\n').find((line) => line.startsWith('#'));
  if (!heading) return undefined;
  const text = heading.replace(/^#+/, '').trim();
  const title = text.startsWith('Task:') ? text.slice('Task:'.length).trim() : text;
  return title || undefined;
}

/** A hidden check that runs longer counts as a fail. */
const CHECK_TIMEOUT_MS = 5 * 60_000;

async function runBash(
  script: string | null,
  cwd: string,
  inline?: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<number | null> {
  const args = script ? [script] : ['-c', inline ?? 'true'];
  // node's own folder, then the system ones: a check never runs a binary from a folder the
  // environment happened to list first, and still finds node and npm on every machine.
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), // NOSONAR
    npm_config_cache: NPM_CACHE,
  };
  // Own process group, so a timeout kills the test runner the script started too: a task
  // whose bug is a hang (task-06) otherwise keeps the hidden check alive forever.
  // The PATH above is fixed on purpose: node's own folder (whichever node runs the bench) and
  // the system folders, nothing from the caller's environment.
  const child = spawn('bash', args, { cwd, env, stdio: 'ignore', detached: true }); // NOSONAR
  return settleWithin(once(child, 'exit') as Promise<[number | null]>, timeoutMs, () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });
}

/**
 * The exit code, or null once `ms` pass: `kill` runs then and the wait ends whether or not the
 * process actually exits (one stuck in uninterruptible I/O would otherwise hold the bench).
 */
export async function settleWithin(
  exit: Promise<[number | null]>,
  ms: number,
  kill: () => void,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      kill();
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([exit.then(([code]) => code), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
