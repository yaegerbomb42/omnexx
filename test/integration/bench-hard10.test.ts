import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getHard10Suite } from '../../bench/suites/index.ts';
import type { TaskDef } from '../../bench/types.ts';

const SUITE_DIR = fileURLToPath(new URL('../../bench/suites/hard10/', import.meta.url));

/** Overlay the reference solution; `solution/.delete` lists paths it removes. */
function applySolution(task: TaskDef, dir: string): void {
  cpSync(join(SUITE_DIR, task.path, 'solution'), dir, { recursive: true });
  const del = join(dir, '.delete');
  if (!existsSync(del)) return;
  for (const p of readFileSync(del, 'utf-8').split('\n').filter(Boolean)) {
    rmSync(join(dir, p), { recursive: true, force: true });
  }
  rmSync(del);
}

describe('hard10 suite', () => {
  it('loads ten tasks, each with a goal, a hidden check and a reference solution', async () => {
    const tasks = await getHard10Suite().loadTasks();
    expect(tasks).toHaveLength(10);
    for (const t of tasks) {
      for (const f of ['goal.md', 'check.sh', 'setup.sh', 'solution', 'hidden', 'repo']) {
        expect(existsSync(join(SUITE_DIR, t.path, f)), `${t.id}/${f}`).toBe(true);
      }
      expect(t.description).not.toBe(t.id);
    }
  });

  // Every task must be unsolved as set up and solved by its reference solution. Slow: one task
  // installs jsdom, and the performance task waits out its time limit on the starting repo.
  it('hidden checks fail on the starting repo and pass with the reference solution', async () => {
    const suite = getHard10Suite();
    const verdicts = await Promise.all(
      (await suite.loadTasks()).map(async (task) => {
        const dir = join(mkdtempSync(join(tmpdir(), 'hard10-ref-')), 'work');
        try {
          await suite.setupTask(task, dir);
          const start = await suite.checkTask(task, dir);
          applySolution(task, dir);
          const reference = await suite.checkTask(task, dir);
          return { id: task.id, start, reference };
        } finally {
          rmSync(dirname(dir), { recursive: true, force: true });
        }
      }),
    );
    expect(verdicts.filter((v) => v.start || !v.reference)).toEqual([]);
  }, 900_000);
});
