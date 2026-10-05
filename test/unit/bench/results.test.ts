import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { createResultsWriter } from '../../../bench/results.js';
import type { TaskRunResult, BenchConfig } from '../../../bench/types.js';

describe('ResultsWriter', () => {
  let testDir: string;
  let config: BenchConfig;

  beforeEach(() => {
    testDir = join(tmpdir(), `omnexx-bench-test-${Date.now()}`);
    config = {
      suite: 'jimmy10',
      agents: ['omnexx', 'claude-code'],
      out: testDir,
    };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createResult(overrides: Partial<TaskRunResult> = {}): TaskRunResult {
    return {
      taskId: 'task-01',
      suite: 'jimmy10',
      agent: 'omnexx',
      metrics: {
        resolved: true,
        usd: 0.05,
        tokens_in: 10000,
        tokens_out: 2000,
        cached: 8000,
        wall_ms: 30000,
        interventions: 0,
      },
      startedAt: '2024-01-01T00:00:00.000Z',
      finishedAt: '2024-01-01T00:00:30.000Z',
      ...overrides,
    };
  }

  it('creates output directory and writes JSONL + markdown', async () => {
    const writer = createResultsWriter(config);
    const result = createResult();

    await writer.writeResult(result);

    const jsonlPath = join(testDir, `${writer.getRunId()}.jsonl`);
    const mdPath = join(testDir, `${writer.getRunId()}.md`);

    expect(existsSync(jsonlPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    // Check JSONL content
    const fs = await import('node:fs/promises');
    const jsonlContent = await fs.readFile(jsonlPath, 'utf-8');
    expect(jsonlContent.trim()).toBe(JSON.stringify(result));

    // Check markdown content
    const mdContent = await fs.readFile(mdPath, 'utf-8');
    expect(mdContent).toContain('# Benchmark Results');
    expect(mdContent).toContain('task-01');
    expect(mdContent).toContain('omnexx');
    expect(mdContent).toContain('✅');
  });

  it('appends multiple results to JSONL and rebuilds markdown', async () => {
    const writer = createResultsWriter(config);
    const result1 = createResult({ taskId: 'task-01', agent: 'omnexx' });
    const result2 = createResult({
      taskId: 'task-02',
      agent: 'claude-code',
      metrics: { ...result1.metrics, resolved: false },
    });

    await writer.writeResult(result1);
    await writer.writeResult(result2);

    const fs = await import('node:fs/promises');
    const jsonlContent = await fs.readFile(join(testDir, `${writer.getRunId()}.jsonl`), 'utf-8');
    const lines = jsonlContent.trim().split('\n');
    expect(lines).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(JSON.parse(lines[0]!)).toEqual(result1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(JSON.parse(lines[1]!)).toEqual(result2);

    const mdContent = await fs.readFile(join(testDir, `${writer.getRunId()}.md`), 'utf-8');
    expect(mdContent).toContain('task-01');
    expect(mdContent).toContain('task-02');
    expect(mdContent).toContain('omnexx');
    expect(mdContent).toContain('claude-code');
  });

  it('writeResults writes multiple results at once', async () => {
    const writer = createResultsWriter(config);
    const results = [
      createResult({ taskId: 'task-01', agent: 'omnexx' }),
      createResult({ taskId: 'task-02', agent: 'omnexx' }),
      createResult({ taskId: 'task-03', agent: 'claude-code' }),
    ];

    await writer.writeResults(results);

    const fs = await import('node:fs/promises');
    const jsonlContent = await fs.readFile(join(testDir, `${writer.getRunId()}.jsonl`), 'utf-8');
    const lines = jsonlContent.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('generates summary row in markdown table', async () => {
    const writer = createResultsWriter(config);
    const results = [
      createResult({
        taskId: 'task-01',
        agent: 'omnexx',
        metrics: { ...createResult().metrics, resolved: true, usd: 0.05 },
      }),
      createResult({
        taskId: 'task-02',
        agent: 'omnexx',
        metrics: { ...createResult().metrics, resolved: false, usd: 0.03 },
      }),
    ];

    await writer.writeResults(results);

    const fs = await import('node:fs/promises');
    const mdContent = await fs.readFile(join(testDir, `${writer.getRunId()}.md`), 'utf-8');
    expect(mdContent).toContain('Summary');
    expect(mdContent).toContain('1/2'); // 1 resolved out of 2
  });

  it('handles different suites in separate sections', async () => {
    const writer = createResultsWriter(config);
    const result1 = createResult({ taskId: 'task-01', suite: 'jimmy10', agent: 'omnexx' });
    const result2 = createResult({ taskId: 'lite50-task', suite: 'lite50', agent: 'omnexx' });

    await writer.writeResult(result1);
    await writer.writeResult(result2);

    const fs = await import('node:fs/promises');
    const mdContent = await fs.readFile(join(testDir, `${writer.getRunId()}.md`), 'utf-8');
    expect(mdContent).toContain('## Suite: jimmy10');
    expect(mdContent).toContain('## Suite: lite50');
  });
});
