import { AgentRunner } from './base.js';
import type { BenchmarkResult, TaskDef } from '../types.js';

/** Runner for the omnexx agent. */
export class OmnexxRunner extends AgentRunner {
  constructor() {
    super('omnexx');
  }

  override async isAvailable(): Promise<boolean> {
    // Check if omnexx is built and available
    try {
      const { stdout } = await this.spawnWithTimeout('node', ['dist/cli.js', '--version'], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async run(_task: TaskDef, _workDir: string): Promise<BenchmarkResult> {
    const startTime = Date.now();

    // Spawn omnexx run --detach and poll status --json
    // For now, this is a stub that returns fake data
    // TODO: Implement actual polling of omnexx status --json

    // Simulate a run
    await new Promise((resolve) => setTimeout(resolve, 100));

    const wallMs = Date.now() - startTime;

    return {
      resolved: true,
      usd: 0.05,
      tokens_in: 10_000,
      tokens_out: 2_000,
      cached: 8_000,
      wall_ms: wallMs,
      interventions: 0,
    };
  }
}

/** Create a fake omnexx runner for testing. */
export function createFakeOmnexxRunner(overrideMetrics?: Partial<BenchmarkResult>): AgentRunner {
  const baseMetrics: BenchmarkResult = {
    resolved: true,
    usd: 0.05,
    tokens_in: 10_000,
    tokens_out: 2_000,
    cached: 8_000,
    wall_ms: 100,
    interventions: 0,
  };

  class FakeOmnexxRunner extends AgentRunner {
    constructor() {
      super('omnexx');
    }

    override async isAvailable(): Promise<boolean> {
      return true;
    }

    override async run(_task: TaskDef, _workDir: string): Promise<BenchmarkResult> {
      return { ...baseMetrics, ...overrideMetrics };
    }
  }

  return new FakeOmnexxRunner();
}
