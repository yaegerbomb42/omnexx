import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
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
    expect(tasks.map((t) => t.id)).toEqual([
      'task-01-fix-typescript-errors',
      'task-02-add-unit-tests',
      'task-03-refactor-legacy-code',
    ]);
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
