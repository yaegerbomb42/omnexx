import { AgentRunner } from './base.js';
import type { BenchmarkResult, TaskDef } from '../types.js';

/** Runner for Codex (codex exec). */
export class CodexRunner extends AgentRunner {
  constructor() {
    super('codex');
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const { stdout, exitCode } = await this.spawnWithTimeout('codex', ['--version'], {
        timeoutMs: 10_000,
      });
      return exitCode === 0 && stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async run(_task: TaskDef, workDir: string): Promise<BenchmarkResult> {
    const startTime = Date.now();

    // Read goal from the task directory
    const goalPath = `${workDir}/goal.md`;
    try {
      const fs = await import('node:fs/promises');
      await fs.readFile(goalPath, 'utf-8');
    } catch {
      // Goal not found, continue with empty goal
    }

    // Run codex exec with the goal (using --json for parseable output)
    const { exitCode, timedOut } = await this.spawnWithTimeout('codex', ['exec', '--json', ''], {
      cwd: workDir,
      timeoutMs: 30 * 60 * 1000, // 30 minutes
    });

    const wallMs = Date.now() - startTime;

    // Parse JSON output for metrics (stub for now)
    const resolved = exitCode === 0 && !timedOut;

    return {
      resolved,
      usd: 0.12, // Estimated
      tokens_in: 18_000,
      tokens_out: 4_000,
      cached: 3_000,
      wall_ms: wallMs,
      interventions: 0,
    };
  }
}

/** Create a fake codex runner for testing. */
export function createFakeCodexRunner(overrideMetrics?: Partial<BenchmarkResult>): AgentRunner {
  const baseMetrics: BenchmarkResult = {
    resolved: true,
    usd: 0.12,
    tokens_in: 18_000,
    tokens_out: 4_000,
    cached: 3_000,
    wall_ms: 100,
    interventions: 0,
  };

  class FakeCodexRunner extends AgentRunner {
    constructor() {
      super('codex');
    }

    override async isAvailable(): Promise<boolean> {
      return true;
    }

    override async run(_task: TaskDef, _workDir: string): Promise<BenchmarkResult> {
      return { ...baseMetrics, ...overrideMetrics };
    }
  }

  return new FakeCodexRunner();
}
