import { AgentRunner } from './base.ts';
import type { AgentRunOutput, BenchmarkResult, TaskDef } from '../types.ts';

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

  override async run(_task: TaskDef, workDir: string, goal: string): Promise<AgentRunOutput> {
    const start = Date.now();
    const { stdout, timedOut } = await this.spawnWithTimeout(
      'claude',
      ['-p', goal, '--output-format', 'json', '--dangerously-skip-permissions'],
      { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 30 * 60_000 },
    );
    const wall_ms = Date.now() - start;
    const out = this.parseJsonLine(stdout.trim().split('\n').at(-1) ?? '') as ClaudeJson | null;
    const u = out?.usage ?? {};
    return {
      resolved: false,
      usd: out?.total_cost_usd ?? 0,
      tokens_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      tokens_out: u.output_tokens ?? 0,
      cached: u.cache_read_input_tokens ?? 0,
      wall_ms,
      interventions: timedOut ? 1 : 0,
    };
  }
}

/** The fields of `claude -p --output-format json` the bench reads. */
interface ClaudeJson {
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
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

    override isAvailable(): Promise<boolean> {
      return Promise.resolve(true);
    }

    override run(): Promise<AgentRunOutput> {
      return Promise.resolve({ ...baseMetrics, ...overrideMetrics });
    }
  }

  return new FakeClaudeCodeRunner();
}
