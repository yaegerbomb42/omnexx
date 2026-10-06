import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export interface CodexAdapterOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export class CodexAdapter implements WorkerBackend {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy = {
    maxRunsPerHour: 10,
    maxRunsPerDay: 40,
    cooldownMs: 3_600_000,
  };

  private readonly binPath: string | undefined;
  private readonly extraArgs: readonly string[];

  constructor(opts: CodexAdapterOptions = {}) {
    this.binPath = opts.path;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.extraArgs = opts.extraArgs ?? [];
  }

  async detect(): Promise<WorkerDetection> {
    const d = await detectExecutable('codex', this.binPath);
    if (!d.installed) return d;
    // Check min version gate: 0.100.0
    const pass = meetsMinVersion(d.version ?? '', '0.100.0');
    return {
      ...d,
      installed: pass,
    };
  }

  buildInvocation(_task: WorkerTask, ctx: InvocationContext): WorkerInvocation {
    const lastMsgFile = join(ctx.worktree, '.omnexx-codex-last-msg.txt');
    const argv = [
      this.binPath ?? 'codex',
      'exec',
      '-C',
      ctx.worktree,
      '-s',
      'workspace-write',
      '--json',
      '--ephemeral',
      '-o',
      lastMsgFile,
      ...this.extraArgs,
      ctx.prompt,
    ];

    return {
      argv,
      env: {
        CODEX_NON_INTERACTIVE: '1',
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
      combined.includes('rate_limit_exceeded') ||
      combined.includes('Rate limit reached') ||
      combined.includes('rate limited')
    ) {
      return { status: 'rate_limited' };
    }

    if (
      combined.includes('insufficient_quota') ||
      combined.includes('quota_exceeded') ||
      combined.includes('QUOTA EXHAUSTED')
    ) {
      return { status: 'quota_exhausted' };
    }

    if (
      combined.includes('authentication_required') ||
      combined.includes('unauthorized') ||
      combined.includes('Missing API key') ||
      combined.includes('auth error')
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
          msg?: string;
          message?: string;
          tokens?: { in?: number; out?: number };
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (item.tokens) {
          inputTokens = item.tokens.in;
          outputTokens = item.tokens.out;
        } else if (item.usage) {
          inputTokens = item.usage.prompt_tokens;
          outputTokens = item.usage.completion_tokens;
        }
        if (item.msg) summary = item.msg;
        else if (item.message) summary = item.message;
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
