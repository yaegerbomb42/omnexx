import { describe, expect, it } from 'vitest';
import { TaskManager } from '../../../src/core/task-manager.js';
import { tmpdir } from 'node:os';

describe('TaskManager', () => {
  it('starts, lists, reads logs, and stops background tasks', async () => {
    const mgr = TaskManager.get();
    const task = await mgr.start('echo "server online" && sleep 5', tmpdir(), process.env);

    expect(task.id).toMatch(/^bg-/);
    expect(task.status).toBe('running');

    const list = mgr.list();
    expect(list.some((t) => t.id === task.id)).toBe(true);

    // Give it a brief moment to write stdout
    await new Promise((r) => setTimeout(r, 200));

    const log = await mgr.readLog(task.id);
    expect(log).toContain('server online');

    const stopped = mgr.stop(task.id);
    expect(stopped).toBe(true);

    const updated = mgr.list().find((t) => t.id === task.id);
    expect(updated?.status).toBe('stopped');
  });
});
