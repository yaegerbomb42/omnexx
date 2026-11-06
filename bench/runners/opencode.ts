import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from './base.ts';
import { meterMetrics, type Meter } from '../meter-metrics.ts';
import type { AgentRunOutput, BenchmarkResult, TaskDef } from '../types.ts';

export interface ExternalRunnerOptions {
  /** Every model call goes through this proxy; `model` is the endpoint's model id. */
  meter: Meter;
  model: string;
  /** Wall-clock cap per task. */
  hours?: number;
}

/**
 * OpenCode CLI in non-interactive mode, on its own data dir, configured as an OpenAI-compatible
 * provider pointing at the meter.
 *
 * OpenCode reads `OPENAI_BASE_URL` / `OPENAI_API_KEY` for its OpenAI provider, and we give it a
 * private data dir (via OPENCODE_DB) so the user's own OpenCode setup is never touched.
 */
export class OpenCodeRunner extends AgentRunner {
  private readonly opts: ExternalRunnerOptions;

  constructor(opts: ExternalRunnerOptions) {
    super('opencode');
    this.opts = opts;
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await this.spawnWithTimeout('opencode', ['--version'], {
        timeoutMs: 10_000,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  override async run(_task: TaskDef, workDir: string, goal: string): Promise<AgentRunOutput> {
    const dataDir = await mkdtemp(join(tmpdir(), 'opencode-bench-'));
    await mkdir(dataDir, { recursive: true });
    const capS = Math.round((this.opts.hours ?? 0.5) * 3_600);
    this.opts.meter.reset();
    const start = Date.now();
    const { timedOut } = await this.spawnWithTimeout(
      'opencode',
      ['run', '--auto', '--dir', workDir, '--model', `openai/${this.opts.model}`, goal],
      {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: (capS + 120) * 1_000,
        env: {
          ...process.env,
          OPENCODE_DB: dataDir,
          OPENAI_BASE_URL: this.opts.meter.url,
          OPENAI_API_KEY: 'metered',
          // Don't inherit the user's real OpenAI credentials; every call goes through the meter.
          OPENAI_ORGANIZATION: undefined,
        },
      },
    );
    return {
      ...meterMetrics(this.opts.meter.totals(), Date.now() - start),
      interventions: timedOut ? 1 : 0,
    };
  }
}

/** Create a fake opencode runner for testing. */
export function createFakeOpenCodeRunner(overrideMetrics?: Partial<BenchmarkResult>): AgentRunner {
  const baseMetrics: BenchmarkResult = {
    resolved: true,
    usd: 0.08,
    tokens_in: 12_000,
    tokens_out: 2_500,
    cached: 4_000,
    wall_ms: 100,
    interventions: 0,
  };

  class FakeOpenCodeRunner extends AgentRunner {
    constructor() {
      super('opencode');
    }

    override isAvailable(): Promise<boolean> {
      return Promise.resolve(true);
    }

    override run(): Promise<AgentRunOutput> {
      return Promise.resolve({ ...baseMetrics, ...overrideMetrics });
    }
  }

  return new FakeOpenCodeRunner();
}
