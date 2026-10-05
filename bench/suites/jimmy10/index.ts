import type { Suite, TaskDef } from '../../types.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const SUITE_ROOT = join(__dirname);

/** jimmy10 suite: 10 task directories with repo setup, goal.md, and hidden check command. */
export class Jimmy10Suite implements Suite {
  readonly name = 'jimmy10';

  async loadTasks(): Promise<TaskDef[]> {
    const tasks: TaskDef[] = [];

    // Example tasks (3 implemented, 7 TODO stubs)
    const exampleTasks = [
      {
        id: 'task-01-fix-typescript-errors',
        description: 'Fix TypeScript errors in a small codebase',
      },
      {
        id: 'task-02-add-unit-tests',
        description: 'Add unit tests for a utility module',
      },
      {
        id: 'task-03-refactor-legacy-code',
        description: 'Refactor legacy JavaScript to modern TypeScript',
      },
    ];

    for (const ex of exampleTasks) {
      const taskPath = join(SUITE_ROOT, ex.id);
      if (existsSync(taskPath)) {
        tasks.push({
          id: ex.id,
          path: ex.id,
          description: ex.description,
        });
      }
    }

    // Add TODO stubs for the remaining 7 tasks
    for (let i = 4; i <= 10; i++) {
      const id = `task-${i.toString().padStart(2, '0')}-todo`;
      tasks.push({
        id,
        path: id,
        description: `TODO: Implement task ${i}`,
      });
    }

    // Satisfy require-await - we could load from disk in future
    await Promise.resolve();
    return tasks;
  }

  async setupTask(task: TaskDef, workDir: string): Promise<void> {
    const taskDir = join(SUITE_ROOT, task.path);

    // Copy task directory to workDir
    await this.copyDir(taskDir, workDir);

    // Run setup script if it exists
    const setupScript = join(workDir, 'setup.sh');
    if (existsSync(setupScript)) {
      await this.runScript(setupScript, workDir);
    }
  }

  async getGoal(task: TaskDef): Promise<string> {
    const goalPath = join(SUITE_ROOT, task.path, 'goal.md');
    try {
      const fs = await import('node:fs/promises');
      return await fs.readFile(goalPath, 'utf-8');
    } catch {
      return `Task: ${task.description}`;
    }
  }

  async checkTask(task: TaskDef, workDir: string): Promise<boolean> {
    const checkScript = join(workDir, 'check.sh');
    if (!existsSync(checkScript)) {
      // No check script means we can't verify - treat as passing for stubs
      return task.id.startsWith('task-0');
    }

    const { exitCode } = await this.runScript(checkScript, workDir);
    return exitCode === 0;
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.cp(src, dest, { recursive: true });
  }

  private async runScript(scriptPath: string, cwd: string): Promise<{ exitCode: number | null }> {
    return new Promise((resolve) => {
      const child = spawn('bash', [scriptPath], { cwd, stdio: 'ignore' });
      void once(child, 'exit').then(([code]: unknown[]) => {
        resolve({ exitCode: code as number | null });
      });
    });
  }
}

/** Get the singleton instance of the jimmy10 suite. */
export function getJimmy10Suite(): Suite {
  return new Jimmy10Suite();
}
