import { describe, it, expect, afterEach } from 'vitest';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cpSync, rmSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getJimmy10Suite } from '../../../bench/suites/index.ts';
import type { TaskDef } from '../../../bench/types.ts';

const task01: TaskDef = {
  id: 'task-01-fix-typescript-errors',
  path: 'task-01-fix-typescript-errors',
  description: 'Fix TypeScript errors',
};

describe('jimmy10 suite', () => {
  const suite = getJimmy10Suite();
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'jimmy10-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('loads only task directories that have a hidden check, titled from goal.md', async () => {
    const tasks = await suite.loadTasks();
    expect(tasks).toHaveLength(10);
    expect(tasks[0]?.id).toBe('task-01-fix-typescript-errors');
    expect(tasks.at(-1)?.id).toBe('task-10-long-inventory-system');
    expect(tasks[0]?.description).toBe('Fix TypeScript Errors');
  });

  it('getGoal reads goal.md from the suite, not the work dir', async () => {
    expect(await suite.getGoal(task01)).toContain('Fix TypeScript Errors');
  });

  it('checkTask runs the suite check.sh in the given dir', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"typecheck":"true","test":"true"}}');
    expect(await suite.checkTask(task01, dir)).toBe(true);
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"typecheck":"false","test":"true"}}');
    expect(await suite.checkTask(task01, dir)).toBe(false);
  });

  it('checkTask fails a task with no check script', async () => {
    expect(await suite.checkTask({ id: 'x', path: 'missing', description: '' }, tmp())).toBe(false);
  });

  it('setupTask leaves a committed repo without the hidden files', async () => {
    const dir = join(tmp(), 'work');
    await suite.setupTask({ id: 'none', path: 'no-such-task', description: '' }, dir);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, 'check.sh'))).toBe(false);
    expect(existsSync(join(dir, 'goal.md'))).toBe(false);
  });
});

const SUITE_DIR = fileURLToPath(new URL('../../../bench/suites/jimmy10/', import.meta.url));

describe('jimmy10 hidden checks', () => {
  // Tasks with a reference solution must be unsolved as set up, and solved by the reference.
  it('fail on the starting repo and pass with the reference solution', async () => {
    const suite = getJimmy10Suite();
    const tasks = (await suite.loadTasks()).filter((t) =>
      existsSync(join(SUITE_DIR, t.path, 'solution')),
    );
    expect(tasks.length).toBeGreaterThanOrEqual(7);
    for (const task of tasks) {
      const dir = join(mkdtempSync(join(tmpdir(), 'jimmy10-ref-')), 'work');
      try {
        await suite.setupTask(task, dir);
        expect(await suite.checkTask(task, dir), `${task.id} starts solved`).toBe(false);
        cpSync(join(SUITE_DIR, task.path, 'solution'), dir, { recursive: true });
        expect(await suite.checkTask(task, dir), `${task.id} reference fails`).toBe(true);
      } finally {
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    }
  }, 120_000);
});
