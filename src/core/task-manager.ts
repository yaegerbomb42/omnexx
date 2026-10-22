import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface BackgroundTask {
  id: string;
  command: string;
  pid: number;
  logPath: string;
  startedAt: number;
  status: 'running' | 'stopped' | 'failed';
  exitCode?: number | null | undefined;
  process?: ChildProcess | undefined;
}

export class TaskManager {
  private static instance: TaskManager | undefined;
  private readonly tasks = new Map<string, BackgroundTask>();

  public static get(): TaskManager {
    TaskManager.instance ??= new TaskManager();
    return TaskManager.instance;
  }

  public async start(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<BackgroundTask> {
    const id = `bg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const logPath = join(tmpdir(), `omnexx-task-${id}.log`);
    const logFd = await open(logPath, 'a', 0o600);

    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
    });

    child.unref();
    await logFd.close();

    const task: BackgroundTask = {
      id,
      command,
      pid: child.pid ?? 0,
      logPath,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      process: child,
    };

    child.on('exit', (code) => {
      task.status = code === 0 ? 'stopped' : 'failed';
      task.exitCode = code;
      task.process = undefined;
    });

    child.on('error', () => {
      task.status = 'failed';
      task.process = undefined;
    });

    this.tasks.set(id, task);
    return task;
  }

  public list(): readonly BackgroundTask[] {
    return Array.from(this.tasks.values()).map((t) => ({
      ...t,
      process: undefined,
    }));
  }

  public async readLog(id: string, maxLines = 100): Promise<string> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    try {
      const content = await readFile(task.logPath, 'utf8');
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '(no output recorded yet)';
    }
  }

  public stop(id: string): boolean {
    const task = this.tasks.get(id);
    if (task?.status !== 'running') return false;
    const pid = task.pid;
    const child = task.process;
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
      setTimeout(() => {
        const proc = child;
        if (!proc || proc.killed || proc.exitCode !== null) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already reaped
          }
        }
      }, 200).unref();
    }
    task.status = 'stopped';
    task.process = undefined;
    return true;
  }

  /** SIGKILL every running child. Tests and shutdown use this so nothing is left behind. */
  public stopAll(): void {
    for (const id of [...this.tasks.keys()]) this.stop(id);
  }
}
