import { AgentRunner } from './base.ts';
import type { AgentRunOutput, BenchmarkResult } from '../types.ts';

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

  override run(): Promise<AgentRunOutput> {
    // `codex exec --json` usage parsing is not wired yet; refuse rather than report made-up numbers.
    return Promise.reject(new Error('codex runner not implemented yet'));
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

    override isAvailable(): Promise<boolean> {
      return Promise.resolve(true);
    }

    override run(): Promise<AgentRunOutput> {
      return Promise.resolve({ ...baseMetrics, ...overrideMetrics });
    }
  }

  return new FakeCodexRunner();
}
