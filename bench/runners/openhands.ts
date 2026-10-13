import { AgentRunner } from './base.ts';
import type { ExternalRunnerOptions } from './cline.ts';
import { meterMetrics } from '../meter-metrics.ts';
import type { AgentRunOutput, TaskDef } from '../types.ts';

/**
 * OpenHands CLI headless with every action approved, working in the task folder, its LLM set
 * from env (LiteLLM's `openai/` prefix for an OpenAI-compatible endpoint) pointing at the meter.
 */
export class OpenHandsRunner extends AgentRunner {
  private readonly opts: ExternalRunnerOptions;

  constructor(opts: ExternalRunnerOptions) {
    super('openhands');
    this.opts = opts;
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await this.spawnWithTimeout('openhands', ['--version'], {
        timeoutMs: 60_000,
        env: { ...process.env, OPENHANDS_SUPPRESS_BANNER: '1' },
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  override async run(_task: TaskDef, workDir: string, goal: string): Promise<AgentRunOutput> {
    const capMs = (this.opts.hours ?? 0.5) * 3_600_000;
    this.opts.meter.reset();
    const start = Date.now();
    const { timedOut } = await this.spawnWithTimeout(
      'openhands',
      [
        '--headless',
        '--always-approve',
        '--override-with-envs',
        '--exit-without-confirmation',
        '-t',
        goal,
      ],
      {
        cwd: workDir,
        env: {
          ...process.env,
          OPENHANDS_SUPPRESS_BANNER: '1',
          LLM_MODEL: `openai/${this.opts.model}`,
          LLM_BASE_URL: this.opts.meter.url,
          LLM_API_KEY: 'metered',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: capMs,
      },
    );
    return {
      ...meterMetrics(this.opts.meter.totals(), Date.now() - start),
      interventions: timedOut ? 1 : 0,
    };
  }
}
