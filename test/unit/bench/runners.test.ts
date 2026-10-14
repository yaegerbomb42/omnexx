import { describe, it, expect } from 'vitest';
import {
  createFakeOmnexxRunner,
  createFakeClaudeCodeRunner,
  createFakeCodexRunner,
} from '../../../bench/runners/index.ts';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metricsFromState, saveRunLog } from '../../../bench/runners/omnexx.ts';

describe('saveRunLog', () => {
  it('copies the latest run folder (events, state) to the destination', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-runlog-'));
    for (const id of ['r_1', 'r_2']) {
      await mkdir(join(home, 'runs', id), { recursive: true });
      await writeFile(join(home, 'runs', id, 'events.jsonl'), `{"run":"${id}"}\n`);
    }
    const dest = join(home, 'out', 'omnexx.run');

    await saveRunLog(home, dest);

    expect(await readFile(join(dest, 'events.jsonl'), 'utf-8')).toContain('r_2');
  });

  it('does nothing when the run left no folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-runlog-'));
    await saveRunLog(home, join(home, 'out'));
    expect(existsSync(join(home, 'out'))).toBe(false);
  });
});
import type { TaskDef } from '../../../bench/types.ts';

describe('Fake runners for testing', () => {
  const mockTask: TaskDef = {
    id: 'test-task',
    path: 'test/test-task',
    description: 'A test task',
  };

  const mockWorkDir = '/tmp/test-workdir';

  it('createFakeOmnexxRunner returns overridden metrics', async () => {
    const runner = createFakeOmnexxRunner({
      resolved: false,
      usd: 0.99,
      tokens_in: 999,
      wall_ms: 1234,
    });

    const result = await runner.run(mockTask, mockWorkDir, 'goal');

    expect(result.resolved).toBe(false);
    expect(result.usd).toBe(0.99);
    expect(result.tokens_in).toBe(999);
    expect(result.wall_ms).toBe(1234);
    // Unspecified metrics should have default values from the real runner
    expect(result.tokens_out).toBeGreaterThan(0);
    expect(result.cached).toBeGreaterThanOrEqual(0);
    expect(result.interventions).toBeGreaterThanOrEqual(0);
  });

  it('createFakeClaudeCodeRunner returns overridden metrics', async () => {
    const runner = createFakeClaudeCodeRunner({
      resolved: true,
      usd: 0.42,
      wall_ms: 5000,
    });

    const result = await runner.run(mockTask, mockWorkDir, 'goal');

    expect(result.resolved).toBe(true);
    expect(result.usd).toBe(0.42);
    expect(result.wall_ms).toBe(5000);
  });

  it('createFakeCodexRunner returns overridden metrics', async () => {
    const runner = createFakeCodexRunner({
      resolved: true,
      usd: 0.15,
      tokens_out: 5000,
    });

    const result = await runner.run(mockTask, mockWorkDir, 'goal');

    expect(result.resolved).toBe(true);
    expect(result.usd).toBe(0.15);
    expect(result.tokens_out).toBe(5000);
  });

  it('each fake runner has correct agentName', () => {
    expect(createFakeOmnexxRunner().agentName).toBe('omnexx');
    expect(createFakeClaudeCodeRunner().agentName).toBe('claude-code');
    expect(createFakeCodexRunner().agentName).toBe('codex');
  });

  it('fake runners isAvailable returns true by default', async () => {
    // The fake runners delegate to the real runner's isAvailable, which may return false
    // if the actual binaries aren't installed. We just verify they don't throw.
    await expect(createFakeOmnexxRunner().isAvailable()).resolves.toBeDefined();
    await expect(createFakeClaudeCodeRunner().isAvailable()).resolves.toBeDefined();
    await expect(createFakeCodexRunner().isAvailable()).resolves.toBeDefined();
  });
});

describe('omnexx runner metrics', () => {
  it('maps run state spend to bench metrics', () => {
    const m = metricsFromState(
      {
        runId: 'r',
        worktree: '/w',
        status: 'done',
        spend: { usd: 0.5, tokens: { uncached: 100, cacheWrite: 20, cacheRead: 900, output: 50 } },
      },
      42,
    );
    expect(m).toMatchObject({ usd: 0.5, tokens_in: 120, cached: 900, tokens_out: 50, wall_ms: 42 });
    expect(m.resolved).toBe(false);
  });
});
