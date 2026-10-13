import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from './base.ts';
import { meterMetrics, type Meter } from '../meter-metrics.ts';
import type { AgentRunOutput, TaskDef } from '../types.ts';

export interface ExternalRunnerOptions {
  /** Every model call goes through this proxy; `model` is the endpoint's model id. */
  meter: Meter;
  model: string;
  /** Wall-clock cap per task. */
  hours?: number;
}

/**
 * Cline CLI in act mode with auto-approve, on its own data dir (so the user's Cline setup is
 * untouched), configured as an OpenAI-compatible provider pointing at the meter.
 */
export class ClineRunner extends AgentRunner {
  private readonly opts: ExternalRunnerOptions;

  constructor(opts: ExternalRunnerOptions) {
    super('cline');
    this.opts = opts;
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await this.spawnWithTimeout('cline', ['--version'], {
        timeoutMs: 10_000,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  override async run(_task: TaskDef, workDir: string, goal: string): Promise<AgentRunOutput> {
    const dataDir = await mkdtemp(join(tmpdir(), 'cline-bench-'));
    const auth = await this.spawnWithTimeout(
      'cline',
      [
        'auth',
        '-p',
        'openai',
        '-k',
        'metered',
        '-m',
        this.opts.model,
        '-b',
        this.opts.meter.url,
        '--data-dir',
        dataDir,
      ],
      { timeoutMs: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (auth.exitCode !== 0) throw new Error(`cline auth failed: ${auth.stderr || auth.stdout}`);
    const capS = Math.round((this.opts.hours ?? 0.5) * 3_600);
    this.opts.meter.reset();
    const start = Date.now();
    const { timedOut } = await this.spawnWithTimeout(
      'cline',
      [
        '--json',
        '--auto-approve',
        'true',
        '--data-dir',
        dataDir,
        '-c',
        workDir,
        '-t',
        String(capS),
        goal,
      ],
      { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: (capS + 120) * 1_000 },
    );
    return {
      ...meterMetrics(this.opts.meter.totals(), Date.now() - start),
      interventions: timedOut ? 1 : 0,
    };
  }
}
