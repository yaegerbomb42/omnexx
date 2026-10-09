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

export interface ClaudeCodeAdapterOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

export class ClaudeCodeAdapter implements WorkerBackend {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly timeoutMs: number;
  readonly quota: QuotaPolicy = {
    maxRunsPerHour: 10,
    maxRunsPerDay: 40,
    cooldownMs: 3_600_000,
  };

  private readonly binPath: string | undefined;
  private readonly extraArgs: readonly string[];

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binPath = opts.path;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    this.extraArgs = opts.extraArgs ?? [];
  }

  async detect(): Promise<WorkerDetection> {
    const d = await detectExecutable('claude', this.binPath);
    if (!d.installed) return d;
    // Check min version gate: 2.0.0
    const pass = meetsMinVersion(d.version ?? '', '2.0.0');
    return {
      ...d,
      installed: pass,
    };
  }

  buildInvocation(_task: WorkerTask, ctx: InvocationContext): WorkerInvocation {
    const prompt = ctx.prompt;
    const argv = [
      this.binPath ?? 'claude',
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'auto',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      ...this.extraArgs,
    ];

    return {
      argv,
      env: {
        // Safe tool-specific environment variables only; never supervisor credentials
        CLAUDE_CODE_STREAM_JSON: '1',
      },
    };
  }

  async parseResult(
    exitCode: number,
    stdoutPath: string,
    stderrPath: string,
  ): Promise<WorkerOutcome> {
    if (exitCode === 143) {
      return { status: 'timeout' };
    }

    const stdout = await readFile(stdoutPath, 'utf8').catch(() => '');
    const stderr = await readFile(stderrPath, 'utf8').catch(() => '');

    const combined = `${stdout}\n${stderr}`;

    if (combined.includes('SIGTERM')) {
      return { status: 'timeout' };
    }

    if (
      combined.includes('rate_limit_error') ||
      combined.includes('Rate limit exceeded') ||
      combined.includes('rate limited')
    ) {
      return { status: 'rate_limited' };
    }

    if (
      combined.includes('quota_exhausted') ||
      combined.includes('insufficient_quota') ||
      combined.includes('credit balance is too low') ||
      combined.includes('usage limit')
    ) {
      return { status: 'quota_exhausted' };
    }

    if (
      combined.includes('authentication_error') ||
      combined.includes('Invalid API Key') ||
      combined.includes('auth_required') ||
      combined.includes('Please log in')
    ) {
      return { status: 'auth_required' };
    }

    // Try extracting cost / tokens from json stream or final message
    let usd: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let summary: string | undefined;

    const lines = stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          total_cost_usd?: number;
          cost?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          result?: string;
          text?: string;
        };
        if (obj.total_cost_usd !== undefined) usd = obj.total_cost_usd;
        if (obj.cost !== undefined) usd = obj.cost;
        if (obj.usage) {
          inputTokens = obj.usage.input_tokens;
          outputTokens = obj.usage.output_tokens;
        }
        if (obj.result) summary = obj.result;
        else if (obj.text) summary = obj.text;
      } catch {
        // Not a JSON line, continue
      }
    }

    if (exitCode === 0) {
      const usage =
        usd !== undefined || inputTokens !== undefined || outputTokens !== undefined
          ? {
              ...(usd !== undefined ? { usd } : {}),
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
