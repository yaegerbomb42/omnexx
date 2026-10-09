import { readFile } from 'node:fs/promises';
import type {
  InvocationContext,
  QuotaPolicy,
  WorkerBackend,
  WorkerDetection,
  WorkerInvocation,
  WorkerOutcome,
  WorkerTask,
} from '../types.js';
import { detectExecutable, meetsMinVersion } from './base.js';

export interface QwenCodeAdapterOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export class QwenCodeAdapter implements WorkerBackend {
  readonly id = 'qwen-code';
  readonly displayName = 'Qwen Code';
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy = {
    maxRunsPerHour: 10,
    maxRunsPerDay: 40,
    cooldownMs: 3_600_000,
  };

  private readonly binPath: string | undefined;
  private readonly extraArgs: readonly string[];

  constructor(opts: QwenCodeAdapterOptions = {}) {
    this.binPath = opts.path;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.extraArgs = opts.extraArgs ?? [];
  }

  async detect(): Promise<WorkerDetection> {
    const d = await detectExecutable('qwen', this.binPath);
    if (!d.installed) return d;
    const pass = meetsMinVersion(d.version ?? '', '0.1.0');
    return {
      ...d,
      installed: pass,
    };
  }

  buildInvocation(_task: WorkerTask, ctx: InvocationContext): WorkerInvocation {
    const argv = [this.binPath ?? 'qwen', '-p', ctx.prompt, ...this.extraArgs];

    return {
      argv,
      env: {},
    };
  }

  async parseResult(
    exitCode: number,
    stdoutPath: string,
    stderrPath: string,
  ): Promise<WorkerOutcome> {
    const stdout = await readFile(stdoutPath, 'utf8').catch(() => '');
    const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
    const combined = `${stdout}\n${stderr}`;

    if (
      combined.includes('RateLimit') ||
      combined.includes('rate_limit') ||
      combined.includes('Too Many Requests')
    ) {
      return { status: 'rate_limited' };
    }

    if (combined.includes('QuotaExceeded') || combined.includes('quota_exhausted')) {
      return { status: 'quota_exhausted' };
    }

    if (
      combined.includes('InvalidApiKey') ||
      combined.includes('Unauthorized') ||
      combined.includes('auth_required')
    ) {
      return { status: 'auth_required' };
    }

    if (exitCode === 0) {
      return {
        status: 'completed',
        summary: stdout.split('\n').filter(Boolean).slice(-1)[0] ?? 'completed',
      };
    }

    return {
      status: 'failed',
      summary: stderr.split('\n')[0] ?? `exited with code ${exitCode}`,
    };
  }
}
