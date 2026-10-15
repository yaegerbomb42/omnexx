import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from './base.ts';
import type { AgentRunOutput, BenchmarkResult, TaskDef } from '../types.ts';

/**
 * An Anthropic-Messages-compatible endpoint for Claude Code. `claude` speaks only the Anthropic
 * Messages API (not OpenAI chat completions), so it cannot go through the bench's OpenAI metering
 * proxy; providers that offer both (DeepSeek: https://api.deepseek.com/anthropic) are reached
 * directly, and tokens come from the usage `claude -p --output-format json` reports, which it
 * takes from the endpoint's own responses.
 */
export interface AnthropicEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** `PREFIX_ANTHROPIC_BASE_URL` (plus the prefix's `_MODEL` and `_API_KEY`), when set. */
export function anthropicEndpointFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: string,
): AnthropicEndpoint | undefined {
  const baseUrl = env[`${prefix}_ANTHROPIC_BASE_URL`]?.trim();
  if (!baseUrl) return undefined;
  const model = (env[`${prefix}_ANTHROPIC_MODEL`] ?? env[`${prefix}_MODEL`])?.trim();
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  if (!model || !apiKey) throw new Error(`${prefix}_MODEL and ${prefix}_API_KEY must be set`);
  return { baseUrl, model, apiKey };
}

/**
 * The environment for a headless `claude` pointed at `ep`: every model role pinned to the
 * endpoint's model, the user's own login and settings kept out (a private config dir and no
 * inherited Anthropic credentials), and non-essential traffic off.
 */
export function claudeEnv(
  base: NodeJS.ProcessEnv,
  ep: AnthropicEndpoint,
  configDir: string,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(base).filter(([k]) => !k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE_')),
  );
  return {
    ...inherited,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: ep.baseUrl,
    ANTHROPIC_AUTH_TOKEN: ep.apiKey,
    ANTHROPIC_MODEL: ep.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: ep.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: ep.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: ep.model,
    ANTHROPIC_SMALL_FAST_MODEL: ep.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

const RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * Runner for Claude Code (`claude -p`). With an endpoint it drives `claude` against that
 * provider; without one it uses whatever account `claude` is logged into (which bills that
 * account, so head-to-head runs should always pass an endpoint).
 */
export class ClaudeCodeRunner extends AgentRunner {
  private readonly endpoint: AnthropicEndpoint | undefined;

  constructor(endpoint?: AnthropicEndpoint) {
    super('claude-code');
    this.endpoint = endpoint;
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
    const configDir = this.endpoint ? await mkdtemp(join(tmpdir(), 'bench-claude-')) : undefined;
    const env =
      this.endpoint && configDir ? claudeEnv(process.env, this.endpoint, configDir) : process.env;
    const args = ['-p', goal, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (this.endpoint) args.push('--model', this.endpoint.model);
    const start = Date.now();
    try {
      const { stdout, timedOut } = await this.spawnWithTimeout('claude', args, {
        cwd: workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: RUN_TIMEOUT_MS,
      });
      return {
        ...metricsFromClaudeJson(stdout),
        wall_ms: Date.now() - start,
        interventions: timedOut ? 1 : 0,
      };
    } finally {
      if (configDir) await rm(configDir, { recursive: true, force: true });
    }
  }
}

/** Metrics from the last line of `claude -p --output-format json`. */
export function metricsFromClaudeJson(
  stdout: string,
): Omit<AgentRunOutput, 'wall_ms' | 'interventions'> {
  const out = parseLastLine(stdout);
  const u = out?.usage ?? {};
  return {
    resolved: false,
    usd: out?.total_cost_usd ?? 0,
    tokens_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    tokens_out: u.output_tokens ?? 0,
    cached: u.cache_read_input_tokens ?? 0,
    ...(out?.num_turns === undefined ? {} : { requests: out.num_turns }),
  };
}

function parseLastLine(stdout: string): ClaudeJson | null {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as ClaudeJson;
  } catch {
    return null;
  }
}

/** The fields of `claude -p --output-format json` the bench reads (num_turns ≈ model calls). */
interface ClaudeJson {
  total_cost_usd?: number;
  num_turns?: number;
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
