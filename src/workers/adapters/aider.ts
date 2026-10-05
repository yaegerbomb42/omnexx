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

export interface AiderAdapterOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export class AiderAdapter implements WorkerBackend {
  readonly id = 'aider';
  readonly displayName = 'Aider';
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy = {
    maxRunsPerHour: 10,
    maxRunsPerDay: 40,
    cooldownMs: 3_600_000,
  };

  private readonly binPath: string | undefined;
  private readonly extraArgs: readonly string[];

  constructor(opts: AiderAdapterOptions = {}) {
    this.binPath = opts.path;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.extraArgs = opts.extraArgs ?? [];
  }

  async detect(): Promise<WorkerDetection> {
    const d = await detectExecutable('aider', this.binPath);
    if (!d.installed) return d;
    // Check min version gate: 0.50.0
    const pass = meetsMinVersion(d.version ?? '', '0.50.0');
    return {
      ...d,
      installed: pass,
    };
  }

  buildInvocation(_task: WorkerTask, ctx: InvocationContext): WorkerInvocation {
    const argv = [
      this.binPath ?? 'aider',
      '--message-file',
      ctx.promptFile,
      '--yes-always',
      '--no-auto-commits',
      ...this.extraArgs,
    ];

    return {
      argv,
      env: {
        AIDER_ANALYTICS: 'false',
      },
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
      combined.includes('RateLimitError') ||
      combined.includes('Rate limit reached') ||
      combined.includes('rate limit exceeded')
    ) {
      return { status: 'rate_limited' };
    }

    if (
      combined.includes('insufficient_quota') ||
      combined.includes('quota_exceeded') ||
      combined.includes('exceeded your current quota')
    ) {
      return { status: 'quota_exhausted' };
    }

    if (
      combined.includes('AuthenticationError') ||
      combined.includes('No API key provided') ||
      combined.includes('API key not found')
    ) {
      return { status: 'auth_required' };
    }

    // Extract cost / tokens if reported by aider output
    let usd: number | undefined;
    const costMatch = /Tokens:.*Cost: \$([0-9.]+)/i.exec(stdout);
    if (costMatch?.[1]) {
      usd = parseFloat(costMatch[1]);
    }

    const summaryMatch = /Applied edit to (.*)/i.exec(stdout);
    const summary = summaryMatch ? summaryMatch[0] : undefined;

    if (exitCode === 0) {
      return {
        status: 'completed',
        ...(summary ? { summary } : {}),
        ...(usd !== undefined ? { usage: { usd } } : {}),
      };
    }

    return {
      status: 'failed',
      summary: summary ?? stderr.split('\n')[0] ?? `exited with code ${exitCode}`,
    };
  }
}
