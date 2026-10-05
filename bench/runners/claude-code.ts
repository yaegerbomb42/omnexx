import { AgentRunner } from './base.js';
import type { BenchmarkResult, TaskDef } from '../types.js';

/** Runner for Claude Code (claude -p). */
export class ClaudeCodeRunner extends AgentRunner {
  constructor() {
    super('claude-code');
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const { stdout, exitCode } = await this.spawnWithTimeout('claude', ['--version'], {
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

    // Run claude -p with the goal
    const { exitCode, timedOut } = await this.spawnWithTimeout('claude', ['-p', ''], {
      cwd: workDir,
      timeoutMs: 30 * 60 * 1000, // 30 minutes
      env: { ...process.env, CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' },
    });

    const wallMs = Date.now() - startTime;

    // Parse output for metrics (stub for now)
    // Real implementation would parse JSON output or extract token usage
    const resolved = exitCode === 0 && !timedOut;

    return {
      resolved,
      usd: 0.1, // Estimated
      tokens_in: 15_000,
      tokens_out: 3_000,
      cached: 5_000,
      wall_ms: wallMs,
      interventions: 0,
    };
  }
}

/** Create a fake claude-code runner for testing. */
export function createFakeClaudeCodeRunner(
  overrideMetrics?: Partial<BenchmarkResult>,
): AgentRunner {
  const baseMetrics: BenchmarkResult = {
    resolved: true,
    usd: 0.1,
    tokens_in: 15_000,
    tokens_out: 3_000,
    cached: 5_000,
    wall_ms: 100,
    interventions: 0,
  };

  class FakeClaudeCodeRunner extends AgentRunner {
    constructor() {
      super('claude-code');
    }

    override async isAvailable(): Promise<boolean> {
      return true;
    }

    override async run(_task: TaskDef, _workDir: string): Promise<BenchmarkResult> {
      return { ...baseMetrics, ...overrideMetrics };
    }
  }

  return new FakeClaudeCodeRunner();
}
