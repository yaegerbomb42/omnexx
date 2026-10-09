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

export interface OpenCodeAdapterOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export class OpenCodeAdapter implements WorkerBackend {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy = {
    maxRunsPerHour: 10,
    maxRunsPerDay: 40,
    cooldownMs: 3_600_000,
  };

  private readonly binPath: string | undefined;
  private readonly extraArgs: readonly string[];

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.binPath = opts.path;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.extraArgs = opts.extraArgs ?? [];
  }

  async detect(): Promise<WorkerDetection> {
    const d = await detectExecutable('opencode', this.binPath);
    if (!d.installed) return d;
    // Check min version gate: 1.0.0
    const pass = meetsMinVersion(d.version ?? '', '1.0.0');
    return {
      ...d,
      installed: pass,
    };
  }

  buildInvocation(_task: WorkerTask, ctx: InvocationContext): WorkerInvocation {
    const argv = [
      this.binPath ?? 'opencode',
      'run',
      '--dir',
      ctx.worktree,
      '--auto',
      '--format',
      'json',
      ...this.extraArgs,
      ctx.prompt,
    ];

    return {
      argv,
      env: {
        OPENCODE_DISABLE_AUTOUPDATE: '1',
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

    if (combined.includes('rate_limit') || combined.includes('Rate limit exceeded')) {
      return { status: 'rate_limited' };
    }

    if (combined.includes('quota_exhausted') || combined.includes('insufficient_quota')) {
      return { status: 'quota_exhausted' };
    }

    if (
      combined.includes('auth_required') ||
      combined.includes('unauthorized') ||
      combined.includes('Please configure provider credentials')
    ) {
      return { status: 'auth_required' };
    }

    let summary: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const lines = stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as {
          type?: string;
          text?: string;
          summary?: string;
          tokens?: { input?: number; output?: number };
        };
        if (item.tokens) {
          inputTokens = item.tokens.input;
          outputTokens = item.tokens.output;
        }
        if (item.summary) summary = item.summary;
        else if (item.text) summary = item.text;
      } catch {
        // continue
      }
    }

    if (exitCode === 0) {
      const usage =
        inputTokens !== undefined || outputTokens !== undefined
          ? {
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
            }
          : undefined;

      return {
        status: 'completed',
        ...(summary !== undefined ? { summary } : {}),
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    return {
      status: 'failed',
      summary: summary ?? stderr.split('\n')[0] ?? `exited with code ${exitCode}`,
    };
  }
}
