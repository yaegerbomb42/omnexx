import { z } from 'zod';
import { durationString } from './duration.js';
import * as extraSections from './sections/index.js';

/**
 * The whole config surface. Unknown keys are errors (strictObject), so a typo in omnexx.toml
 * fails loudly instead of being silently ignored. Every section exists from M0 on so later
 * milestones never change the surface; keys whose behavior ships later say so in docs/config.md.
 */

export const GATE_PARSERS = [
  'generic',
  'vitest',
  'jest',
  'node-test',
  'tsc',
  'eslint',
  'pytest',
  'gotest',
] as const;
export type GateParser = (typeof GATE_PARSERS)[number];

export const gateSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'gate names may use letters, digits, _ . -'),
  run: z.string().min(1),
  timeout: durationString.default('10m'),
  level: z.enum(['must-pass', 'ratchet']).default('ratchet'),
  parser: z.enum(GATE_PARSERS).default('generic'),
  /** Re-runs of the whole gate when it shows new, named failures; ids that then pass are flaky. */
  flaky_reruns: z.number().int().min(0).max(3).default(1),
  /**
   * "browser": `run` starts the app (it gets a free port in $PORT), the gate waits for `url`,
   * then checks it in a real browser with `script`'s steps, or a smoke check without one.
   */
  kind: z.enum(['command', 'browser']).default('command'),
  url: z.string().default('http://localhost:${PORT}'),
  script: z.string().optional(),
  /** Pass without running while package.json has no script of this name (e.g. "start"). */
  requires_script: z.string().optional(),
});
export type GateConfig = z.infer<typeof gateSchema>;

export const budgetSchema = z.strictObject({
  max_usd: z.number().positive().default(50),
  /** Accepted now so the surface is stable; enforced from M3 (rolling 24 h pause). */
  max_usd_per_day: z.number().positive().default(50),
  max_hours: z.number().positive().default(24),
  max_cycles: z.number().int().positive().default(300),
  max_turns_per_cycle: z.number().int().positive().default(40),
  max_tokens_per_cycle: z.number().int().positive().default(400_000),
  max_cmd_timeout: durationString.default('30m'),
  warn_at: z.number().gt(0).lt(1).default(0.8),
  /** In the last fraction of budget or time, start no new task: finish, verify lastGreen, report, stop. */
  wrapup_reserve: z.number().min(0).lt(1).default(0.08),
});

const modelRef = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:\S+$/, 'expected "<provider>:<alias-or-model-id>"');

/** One model, or a failover chain tried in order (e.g. ["anthropic:sonnet", "openrouter:sonnet"]). */
const modelChain = z.union([modelRef, z.array(modelRef).min(1).max(8)]);
export type ModelChainInput = z.infer<typeof modelChain>;

/** What a model can do and how good/fast it is; the router filters and describes candidates with it. */
export const modelProfileSchema = z.strictObject({
  tags: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
  /** Context window in tokens. */
  context: z.number().int().positive().optional(),
  tools: z.boolean().default(true),
  vision: z.boolean().default(false),
  speed: z.enum(['fast', 'normal', 'slow']).optional(),
  quality: z.enum(['low', 'mid', 'high']).optional(),
});
export type ModelProfileConfig = z.infer<typeof modelProfileSchema>;

export const modelsSchema = z.strictObject({
  planner: modelChain.default('anthropic:opus'),
  worker: modelChain.default('anthropic:sonnet'),
  cheap: modelChain.default('anthropic:haiku'),
  /** Chat mode's model; the worker chain when unset. `/model` overrides it for a session. */
  chat: modelRef.optional(),
  /** Extra models the router may pick that aren't in any role chain. */
  extra: z.array(modelRef).default([]),
  /** Keyed by model ref, e.g. [models.profiles."groq:llama-4-70b"]. */
  profiles: z.record(modelRef, modelProfileSchema).default({}),
});

export const priceSchema = z.strictObject({
  id: z.string().min(1),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_write_5m: z.number().nonnegative(),
  cache_write_1h: z.number().nonnegative(),
  cache_read: z.number().nonnegative(),
  max_output_tokens: z.number().int().positive().optional(),
});
export type PriceConfig = z.infer<typeof priceSchema>;

/** Optional per-provider spend caps, on top of the run-level budget. */
const providerBudget = {
  max_usd: z.number().positive().optional(),
  max_usd_per_day: z.number().positive().optional(),
};

/**
 * A model endpoint. `openai` is Chat Completions (OpenAI, OpenRouter, LiteLLM, Ollama, vLLM);
 * `responses` is the OpenAI Responses API; `gemini` is Google's native API.
 */
export const endpointSchema = z.strictObject({
  kind: z.enum(['openai', 'responses', 'gemini']).default('openai'),
  base_url: z.url(),
  /** Name of the env var holding the key (never the key itself). Optional for local endpoints. */
  api_key_env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  /** Price every model on this endpoint at $0 unless [pricing] says otherwise (local models). */
  free: z.boolean().default(false),
  request_timeout: durationString.default('10m'),
  ...providerBudget,
});
export type EndpointConfig = z.infer<typeof endpointSchema>;

export const anthropicSchema = z.strictObject({
  ...providerBudget,
  base_url: z.url().optional(),
  cache_ttl: z.enum(['5m', '1h']).default('5m'),
  /**
   * TTL for the stable prefix (tools, system, codemap, goal, notes). "auto" = 1h on runs longer
   * than an hour: gates between cycles often outlast 5 minutes, and a 1h write is reread every cycle.
   */
  prefix_cache_ttl: z.enum(['auto', '5m', '1h']).default('auto'),
  /** Output cap per turn; also the worst-case output used by the budget pre-flight. */
  max_tokens: z.number().int().positive().default(16_000),
  request_timeout: durationString.default('10m'),
});

export const providersSchema = z.strictObject({
  anthropic: anthropicSchema.prefault({}),
  /** Named OpenAI-compatible endpoints; the name is the model-ref prefix ("openrouter:…"). */
  endpoints: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), endpointSchema).default({}),
});

export const gitSchema = z.strictObject({
  push: z.enum(['none', 'branch']).default('none'),
  remote: z.string().default('origin'),
  /** Opening a PR at the end is planned for M5. `true` fails at run start. */
  open_pr: z.boolean().default(false),
});

export const NOTIFY_EVENTS = [
  'started',
  'finished',
  'needs-human',
  'budget',
  'crash',
  'outage',
  'stopped',
] as const;

export const ntfySchema = z.strictObject({
  server: z.url().default('https://ntfy.sh'),
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ntfy topics use letters, digits, _ and -'),
  token_env: z.string().optional(),
  events: z
    .array(z.enum(NOTIFY_EVENTS))
    .default(['started', 'finished', 'needs-human', 'budget', 'crash', 'outage']),
  timeout_ms: z.number().int().positive().default(5_000),
});

export const notifySchema = z.strictObject({
  ntfy: ntfySchema.optional(),
});

export const JUDGE_USES = [
  'next_move',
  'drift',
  'failure_similarity',
  'tool_safety',
  'route',
] as const;
export type JudgeUse = (typeof JUDGE_USES)[number];

export const nimbleSchema = z.strictObject({
  url: z.url().default('http://localhost:11434'),
  model: z.string().default('nimble'),
  timeout_ms: z.number().int().positive().default(3_000),
  keep_alive: z.string().default('30m'),
  breaker_failures: z.number().int().positive().default(3),
  breaker_reprobe: durationString.default('10m'),
});

export const judgeSchema = z.strictObject({
  kind: z.enum(['none', 'nimble', 'llm']).default('none'),
  fallback: z.enum(['none', 'llm']).default('none'),
  mode: z.enum(['advise', 'steer']).default('advise'),
  steer_min_probability: z.number().min(0).max(1).default(0.6),
  uses: z.array(z.enum(JUDGE_USES)).default([...JUDGE_USES]),
  nimble: nimbleSchema.prefault({}),
});

export const stuckSchema = z.strictObject({
  max_consecutive_rejections: z.number().int().positive().default(3),
  max_same_signature: z.number().int().positive().default(3),
  /** A task that has used this many cycles (accepted-partial or rejected) without finishing is stuck. */
  max_task_cycles: z.number().int().positive().default(8),
  no_progress_cycles: z.number().int().positive().default(8),
  no_progress_hours: z.number().positive().default(3),
  oscillation_window: z.number().int().positive().default(5),
  /** In-cycle: the same tool call with the same arguments this many times ends the cycle. */
  repeated_tool_call: z.number().int().min(2).default(3),
  /** In-cycle: this many turns without a file edit ends the cycle. */
  no_edit_turns: z.number().int().positive().default(15),
  /** In-cycle: tokens above this multiple of the median cycle, with no edit yet, end the cycle. */
  burn_factor: z.number().gt(1).default(3),
});

export const contextSchema = z.strictObject({
  progress_tail: z.number().int().nonnegative().default(5),
  notes_max_tokens: z.number().int().positive().default(1_500),
  repo_map_max_tokens: z.number().int().positive().default(3_000),
  /** In-cycle: past this many context tokens, elide old large tool results. */
  clear_tool_results_at: z.number().int().positive().default(60_000),
  /** The newest tool results that are never cleared. */
  keep_tool_results: z.number().int().nonnegative().default(6),
  /** In-cycle: past this many context tokens, summarize older turns with the cheap model. */
  compact_at: z.number().int().positive().default(100_000),
  /** Recent assistant turns kept verbatim through a compaction. */
  compact_keep_turns: z.number().int().positive().default(4),
  /** `task` subagents: input+output tokens and turns each child may use. */
  subagent_max_tokens: z.number().int().positive().default(150_000),
  subagent_max_turns: z.number().int().positive().default(15),
  /** `task` calls made in the same turn run together, at most this many at once. */
  subagent_parallel: z.number().int().min(1).max(8).default(3),
});

export const policySchema = z.strictObject({
  /** Extra command names to deny on top of the built-in list. */
  deny: z.array(z.string()).default([]),
  /** Allow `curl` / `wget` (still never piped into a shell). */
  allow_network: z.boolean().default(false),
  /** Extra environment variable names passed through to child processes. */
  env_passthrough: z.array(z.string()).default([]),
});

export const serviceSchema = z.strictObject({
  nice: z.number().int().min(-20).max(19).default(10),
  cpu_quota: z
    .string()
    .regex(/^\d+%$/, 'expected a percentage like "150%"')
    .optional(),
  memory_max: z
    .string()
    .regex(/^\d+[KMGT]?$/, 'expected a size like "4G"')
    .optional(),
});

export const DEFAULT_PROTECTED = [
  'omnexx.toml',
  '.github/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  '.env*',
  '**/.env*',
];

/** One table per worker. Unknown IDs are accepted so M3 adapters don't change the surface. */
export const workerSchema = z.strictObject({
  enabled: z.boolean().default(false),
  path: z.string().optional(),
  timeout: durationString.default('20m'),
  route: z.array(z.string()).default(['tests', 'lint', 'small-refactor', 'docs']),
  max_runs_per_hour: z.number().int().positive().default(10),
  max_runs_per_day: z.number().int().positive().default(40),
  cooldown: durationString.default('1h'),
  extra_args: z.array(z.string()).default([]),
});
export type WorkerConfig = z.infer<typeof workerSchema>;

const WORKER_TABLE_KEYS = new Set(['max_concurrent', 'priority']);

export const workersSchema = z
  .looseObject({
    max_concurrent: z.number().int().positive().default(1),
    priority: z
      .array(z.string())
      .default(['aider', 'opencode', 'cline', 'pi', 'hermes', 'openhands', 'claude-code']),
  })
  .transform((raw, ctx) => {
    const backends: Record<string, WorkerConfig> = {};
    for (const [id, value] of Object.entries(raw)) {
      if (WORKER_TABLE_KEYS.has(id)) continue;
      const parsed = workerSchema.safeParse(value ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [id, ...issue.path] });
        }
        continue;
      }
      backends[id] = parsed.data;
    }
    return { max_concurrent: raw.max_concurrent, priority: raw.priority, backends };
  });

/** Used when sandbox = "docker". */
export const dockerSchema = z.strictObject({
  image: z.string().default('node:22-bookworm'),
  /** "bridge" lets setup and gates reach package registries; "none" cuts the network off. */
  network: z.enum(['bridge', 'none']).default('bridge'),
  cpus: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('2'),
  memory: z
    .string()
    .regex(/^\d+[kmg]?$/i)
    .default('4g'),
  pids_limit: z.number().int().positive().default(1024),
  tmp_size: z
    .string()
    .regex(/^\d+[kmg]?$/i)
    .default('2g'),
});

export const configSchema = z.strictObject({
  setup: z.array(z.string()).default([]),
  sandbox: z.enum(['host', 'docker']).default('host'),
  docker: dockerSchema.prefault({}),
  protected: z.array(z.string()).default(DEFAULT_PROTECTED),
  gates: z.array(gateSchema).default([]),
  budget: budgetSchema.prefault({}),
  models: modelsSchema.prefault({}),
  pricing: z.record(z.string(), priceSchema).default({}),
  providers: providersSchema.prefault({}),
  git: gitSchema.prefault({}),
  notify: notifySchema.prefault({}),
  judge: judgeSchema.prefault({}),
  stuck: stuckSchema.prefault({}),
  context: contextSchema.prefault({}),
  policy: policySchema.prefault({}),
  service: serviceSchema.prefault({}),
  workers: workersSchema.prefault({}),
  ...extraSections,
});

export type OmnexxConfig = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
