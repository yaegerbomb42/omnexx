import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getWeb5Suite } from '../../../bench/suites/index.ts';
// @ts-expect-error: plain ESM helper without type declarations.
import { findChrome } from '../../../bench/suites/web5/lib/probe.mjs';

const SUITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../bench/suites/web5');
/** Tasks whose hidden check drives headless Chrome; skipped on a machine without one. */
const NEEDS_CHROME = new Set(['task-02-fix-mobile-overflow', 'task-05-frontend-console-errors']);
const hasChrome = (findChrome as () => string | null)() !== null;
/** Setup, two hidden checks and maybe Chrome per task: slower than the default 5 s. */
const TASK_TIMEOUT_MS = 120_000;

describe('web5 suite', () => {
  const suite = getWeb5Suite();
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('loads five tasks, each with a goal that points at its local docs or page', async () => {
    const tasks = await suite.loadTasks();
    expect(tasks.map((t) => t.id)).toEqual([
      'task-01-unfamiliar-library',
      'task-02-fix-mobile-overflow',
      'task-03-rate-card-lookup',
      'task-04-migrate-datekit',
      'task-05-frontend-console-errors',
    ]);
    for (const t of tasks) expect(await suite.getGoal(t)).toMatch(/http:\/\/127\.0\.0\.1:48\d\d/);
  });

  // Each task: the untouched repo fails its hidden check and the reference solution passes.
  for (const id of [
    'task-01-unfamiliar-library',
    'task-02-fix-mobile-overflow',
    'task-03-rate-card-lookup',
    'task-04-migrate-datekit',
    'task-05-frontend-console-errors',
  ]) {
    it.skipIf(NEEDS_CHROME.has(id) && !hasChrome)(
      `${id}: fails untouched, passes with the reference solution`,
      async () => {
        const task = { id, path: id, description: '' };
        const work = join(mkdtempSync(join(tmpdir(), 'web5-')), 'work');
        dirs.push(dirname(work));
        await suite.setupTask(task, work);
        expect(existsSync(join(work, '.docs/serve.sh'))).toBe(true);
        expect(await suite.checkTask(task, work)).toBe(false);
        cpSync(join(SUITE_ROOT, id, 'solution'), work, { recursive: true });
        expect(await suite.checkTask(task, work)).toBe(true);
      },
      TASK_TIMEOUT_MS,
    );
  }

  it(
    'serve.sh serves the docs site over local HTTP',
    async () => {
      const task = { id: 'task-03-rate-card-lookup', path: 'task-03-rate-card-lookup' };
      const work = join(mkdtempSync(join(tmpdir(), 'web5-')), 'work');
      dirs.push(dirname(work));
      await suite.setupTask({ ...task, description: '' }, work);
      expect(readFileSync(join(work, '.docs/serve.sh'), 'utf-8')).toContain(' 4803');
      const child = spawn('bash', [join(work, '.docs/serve.sh')], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      try {
        const [line] = (await once(child.stdout, 'data')) as [Buffer];
        expect(line.toString()).toContain('http://127.0.0.1:4803/');
        const res = await fetch('http://127.0.0.1:4803/carriers/rates.html');
        expect(await res.text()).toContain('2026 rate card');
        expect((await fetch('http://127.0.0.1:4803/robots.txt')).status).toBe(404);
      } finally {
        child.kill();
      }
    },
    TASK_TIMEOUT_MS,
  );
});
