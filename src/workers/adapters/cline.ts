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

export interface ClineAdapterOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

/**
 * Cline CLI adapter.
 * Headless execution is supported via `cline --json --auto-approve true --cwd <wt> <prompt>`.
 * Note: If an older version lacks `--auto-approve` or `--json`, `detect()` marks installed as false.
 */
export class ClineAdapter implements WorkerBackend {
  readonly id = 'cline';
  readonly displayName = 'Cline CLI';
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy = {
    maxRunsPerHour: 10,
    maxRunsPerDay: 40,
    cooldownMs: 3_600_000,
  };

  private readonly binPath: string | undefined;
  private readonly extraArgs: readonly string[];

  constructor(opts: ClineAdapterOptions = {}) {
    this.binPath = opts.path;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.extraArgs = opts.extraArgs ?? [];
  }

  async detect(): Promise<WorkerDetection> {
    const d = await detectExecutable('cline', this.binPath);
    if (!d.installed) return d;
    // Cline CLI needs json output and auto-approve flags for headless automation
    const hasHeadlessFlags =
      d.capabilities.includes('json') || meetsMinVersion(d.version ?? '', '3.0.0');

    return {
      ...d,
      installed: hasHeadlessFlags,
    };
  }

  buildInvocation(_task: WorkerTask, ctx: InvocationContext): WorkerInvocation {
    const argv = [
      this.binPath ?? 'cline',
      '--json',
      '--auto-approve',
      'true',
      '--cwd',
      ctx.worktree,
      ...this.extraArgs,
      ctx.prompt,
    ];

    return {
      argv,
      env: {
        CLINE_NON_INTERACTIVE: '1',
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
      combined.includes('rate_limit') ||
      combined.includes('rate limit exceeded') ||
      combined.includes('RateLimitError')
    ) {
      return { status: 'rate_limited' };
    }

    if (combined.includes('quota_exhausted') || combined.includes('insufficient_quota')) {
      return { status: 'quota_exhausted' };
    }

    if (
      combined.includes('auth_required') ||
      combined.includes('unauthorized') ||
      combined.includes('Missing API key')
    ) {
      return { status: 'auth_required' };
    }

    let summary: string | undefined;
    const lines = stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as {
          type?: string;
          message?: string;
          say?: string;
        };
        if (item.say === 'text' && item.message) summary = item.message;
        else if (item.message) summary = item.message;
      } catch {
        // continue
      }
    }

    if (exitCode === 0) {
      return {
        status: 'completed',
        ...(summary ? { summary } : {}),
      };
    }

    return {
      status: 'failed',
      summary: summary ?? stderr.split('\n')[0] ?? `exited with code ${exitCode}`,
    };
  }
}
