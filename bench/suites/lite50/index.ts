import type { Suite, TaskDef } from '../../types.js';
import { join } from 'node:path';

/** lite50 suite: loads a JSON list of SWE-bench Lite instance IDs (stub, no download). */
export class Lite50Suite implements Suite {
  readonly name = 'lite50';

  async loadTasks(): Promise<TaskDef[]> {
    // This is a stub - in reality this would load from a JSON file of SWE-bench Lite instances
    // For now, return a few example task definitions
    const instanceIds = [
      'django__django-11039',
      'django__django-11099',
      'django__django-11101',
      'django__django-11109',
      'django__django-11139',
      // ... 45 more would be loaded from JSON
    ];

    // Satisfy require-await
    await Promise.resolve();

    return instanceIds.map((id, index) => ({
      id,
      path: `lite50/${id}`,
      description: `SWE-bench Lite instance ${id} (${index + 1}/50)`,
    }));
  }

  async setupTask(task: TaskDef, workDir: string): Promise<void> {
    // Stub: In reality, this would clone the repo at the specific commit,
    // apply the test patch, and set up the environment.
    // For testing, we just create a minimal structure.
    const fs = await import('node:fs/promises');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      join(workDir, 'goal.md'),
      `# SWE-bench Lite: ${task.id}\n\nFix the issue described in the problem statement.`,
    );
    await fs.writeFile(join(workDir, 'problem.md'), 'Problem statement would go here (stub).');
  }

  async getGoal(task: TaskDef): Promise<string> {
    // Satisfy require-await
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return `Fix the issue in SWE-bench Lite instance ${task.id}. See problem.md for details.`;
  }

  async checkTask(task: TaskDef, _workDir: string): Promise<boolean> {
    // Stub: In reality, this would run the test suite for the specific instance.
    // For testing, we return true for the first few tasks.
    // Satisfy require-await
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
    const index = parseInt(task.id.split('-').pop() ?? '0', 10);
    return index < 3; // First 3 "pass" for demo purposes
  }
}

/** Get the singleton instance of the lite50 suite. */
export function getLite50Suite(): Suite {
  return new Lite50Suite();
}
