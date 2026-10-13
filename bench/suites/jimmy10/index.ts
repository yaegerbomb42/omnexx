import type { Suite, TaskDef } from '../../types.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const SUITE_ROOT = dirname(fileURLToPath(import.meta.url));
/** A private npm cache: a shared one can be unwritable or locked by other tools. */
const NPM_CACHE = join(tmpdir(), 'omnexx-bench-npm-cache');

/**
 * jimmy10 suite: each task directory holds `setup.sh` (builds the repo), `goal.md` (the prompt)
 * and `check.sh` (the hidden acceptance check). Only setup's output is visible to the agent.
 */
export class Jimmy10Suite implements Suite {
  readonly name = 'jimmy10';

  async loadTasks(): Promise<TaskDef[]> {
    const entries = await readdir(SUITE_ROOT, { withFileTypes: true });
    const tasks: TaskDef[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || !existsSync(join(SUITE_ROOT, e.name, 'check.sh'))) continue;
      const goal = await readFile(join(SUITE_ROOT, e.name, 'goal.md'), 'utf-8').catch(() => '');
      const title = /^#\s*(?:Task:\s*)?(.+)$/m.exec(goal)?.[1]?.trim() ?? e.name;
      tasks.push({ id: e.name, path: e.name, description: title });
    }
    return tasks;
  }

  async setupTask(task: TaskDef, workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const setup = join(SUITE_ROOT, task.path, 'setup.sh');
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
      return await readFile(join(SUITE_ROOT, task.path, 'goal.md'), 'utf-8');
    } catch {
      return `Task: ${task.description}`;
    }
  }

  async checkTask(task: TaskDef, workDir: string): Promise<boolean> {
    const check = join(SUITE_ROOT, task.path, 'check.sh');
    if (!existsSync(check)) return false;
    return (await runBash(check, workDir)) === 0;
  }
}

/** A hidden check that runs longer counts as a fail. */
const CHECK_TIMEOUT_MS = 5 * 60_000;

async function runBash(
  script: string | null,
  cwd: string,
  inline?: string,
): Promise<number | null> {
  const args = script ? [script] : ['-c', inline ?? 'true'];
  // A fixed PATH (system folders only), so a check never runs a binary from a
  // folder the environment happened to list first.
  const env = {
    ...process.env,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    npm_config_cache: NPM_CACHE,
  };
  // Own process group, so a timeout kills the test runner the script started too: a task
  // whose bug is a hang (task-06) otherwise keeps the hidden check alive forever.
  const child = spawn('bash', args, { cwd, env, stdio: 'ignore', detached: true });
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, CHECK_TIMEOUT_MS);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(timer);
  return code;
}

/** Get the singleton instance of the jimmy10 suite. */
export function getJimmy10Suite(): Suite {
  return new Jimmy10Suite();
}
