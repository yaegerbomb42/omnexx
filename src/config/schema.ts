import { ROLE_NAMES } from './roles.js';
import { STRATEGIES } from './routing.js';
import { sectionsSchema } from '../agent/sections.js';
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
  'cargo',
] as const;
export type GateParser = (typeof GATE_PARSERS)[number];

export const gateSchema = z
  .strictObject({
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'gate names may use letters, digits, _ . -'),
    /** The command to run; unused (and may be empty) for `kind: "exists"` gates. */
    run: z.string().default(''),
    timeout: durationString.default('10m'),
    level: z.enum(['must-pass', 'ratchet']).default('ratchet'),
    parser: z.enum(GATE_PARSERS).default('generic'),
    /** Re-runs of the whole gate when it shows new, named failures; ids that then pass are flaky. */
    flaky_reruns: z.number().int().min(0).max(3).default(1),
    /**
     * "browser": `run` starts the app (it gets a free port in $PORT), the gate waits for `url`,
     * then checks it in a real browser with `script`'s steps, or a smoke check without one.
     * "exists": no command runs; the gate passes when `path` exists in the workspace — an
     * artifact check for work with no test suite (the general domain's typical gate).
     */
    kind: z.enum(['command', 'browser', 'exists']).default('command'),
    /** For `kind: "exists"`: the workspace-relative file or directory that must exist. */
    path: z.string().optional(),
    url: z.string().default('http://localhost:${PORT}'),
    script: z.string().optional(),
    /** Pass without running while package.json has no script of this name (e.g. "start"). */
    requires_script: z.string().optional(),
  })
  .superRefine((gate, ctx) => {
    if (gate.kind === 'exists') {
      if (!gate.path)
        ctx.addIssue({
          code: 'custom',
          path: ['path'],
          message: 'exists gates need a path to check',
        });
    } else if (!gate.run) {
      ctx.addIssue({
        code: 'custom',
        path: ['run'],
        message: 'command and browser gates need a run command',
      });
    }
  });
export type GateConfig = z.infer<typeof gateSchema>;

export const budgetSchema = z.strictObject({
  max_usd: z.number().positive().default(50),
  /** Accepted now so the surface is stable; enforced from M3 (rolling 24 h pause). */
  max_usd_per_day: z.number().positive().default(50),
  max_hours: z.number().positive().default(24),
  max_cycles: z.number().int().positive().default(300),
  max_turns_per_cycle: z.number().int().positive().default(40),
  /** Run-level turn cap: unset means no cap. Hitting it ends the run as expired. */
  max_turns: z.number().int().positive().optional(),
  max_tokens_per_cycle: z.number().int().positive().default(400_000),
  /**
   * Per-task caps on top of the run-level budget. A single runaway task is parked (checkpointed
   * and stopped) when it reaches either cap, even if the run still has money left. Unset: off.
   */
  task_max_tokens: z.number().int().positive().optional(),
  task_max_usd: z.number().positive().optional(),
  max_cmd_timeout: durationString.default('30m'),
  /**
   * How long a run waits when no model in the chain can take a call (every quota used up, keys
   * rejected, or every provider down) before it stops with budget-stop instead of waiting on.
   */
  max_provider_wait: durationString.default('6h'),
  warn_at: z.number().gt(0).lt(1).default(0.8),
  /** In the last fraction of budget or time, start no new task: finish, verify lastGreen, report, stop. */
  wrapup_reserve: z.number().min(0).lt(1).default(0.08),
});

const modelRef = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:\S+$/, 'expected "<provider>:<alias-or-model-id>"');

/** One model, or a failover chain tried in order (e.g. ["anthropic:sonnet", "openrouter:sonnet"]). */
// Long: free pools give each model its own quota, and a run walks the chain as they run out.
const modelChain = z.union([modelRef, z.array(modelRef).min(1).max(40)]);
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
  /** Chat mode's ranked models; the worker chain when unset. `/model` overrides it for a session. */
  chat: modelChain.optional(),
  /** Models for helpers (subagents); the router's pick when unset. */
  helpers: modelChain.optional(),
  /** Helpers running at the same time start on different providers of the helpers chain. */
  spread_helpers: z.boolean().default(true),
  /** How each role uses its models: fallback, priority, random (or least-busy, smart). */
  routing: z.partialRecord(z.enum(ROLE_NAMES), z.enum(STRATEGIES)).default({}),
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
 * `responses` is the OpenAI Responses API; `gemini` is Google's native API; `anthropic` is the
 * Anthropic Messages API (Anthropic-compatible gateways).
 */
export const endpointSchema = z.strictObject({
  kind: z.enum(['openai', 'responses', 'gemini', 'anthropic']).default('openai'),
  base_url: z.url(),
  /** How the key is sent: a bearer token (default), an `api-key` header (Azure), or not at all. */
  auth: z.enum(['bearer', 'api-key', 'none']).optional(),
  /** Extra request headers (not secrets: config files are plain text). */
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(1000)).optional(),
  /** Name of the env var holding the key (never the key itself). Optional for local endpoints. */
  api_key_env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  /**
   * More env vars holding keys for the same endpoint. Calls rotate to the next key on a 429,
   * so free tiers that rate-limit per key keep going. Unset ones are skipped.
   */
  api_key_envs: z
    .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
    .max(50)
    .optional(),
  /** Price every model on this endpoint at $0 unless [pricing] says otherwise (local models). */
  free: z.boolean().default(false),
  request_timeout: durationString.default('10m'),
  /**
   * A request that sends nothing for this long (no headers, no next chunk) is cut and retried,
   * instead of waiting out request_timeout. Requests stream so this shows. Unset: 3m for remote
   * endpoints, off for localhost (a slow machine can take minutes to read a long prompt); "off"
   * turns it off.
   */
  stall_timeout: z.union([durationString, z.literal('off')]).optional(),
  /**
   * For pools that route a `*-random` model to a different model each request: omnexx picks one
   * real model itself and sticks to it (warm prompt cache) until it runs out of quota.
   */
  sticky_random: z.boolean().default(false),
  /** Circuit breaker: consecutive 5xx/outage failures before opening (default 5). */
  breaker_failures: z.number().int().positive().default(5),
  /** Circuit breaker: initial cooloff before half-open probe (default 10s). */
  breaker_cooloff: durationString.default('10s'),
  /** Circuit breaker: maximum cooloff (default 5m). */
  breaker_max_cooloff: durationString.default('5m'),
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
  /** At the end of a run with commits: push the branch and open a PR with `gh`. */
  open_pr: z.boolean().default(false),
  /** The PR's base branch; default: the branch the checkout is on when the run ends. */
  pr_base: z.string().optional(),
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

/** A Slack- or Discord-compatible incoming webhook (the URL is a secret: read from an env var). */
export const webhookSchema = z.strictObject({
  url_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  events: z
    .array(z.enum(NOTIFY_EVENTS))
    .default(['finished', 'needs-human', 'budget', 'crash', 'outage']),
  timeout_ms: z.number().int().positive().default(5_000),
});

export const notifySchema = z.strictObject({
  ntfy: ntfySchema.optional(),
  webhook: webhookSchema.optional(),
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
  no_progress_cycles: z.number().int().positive().default(12),
  no_progress_hours: z.number().positive().default(3),
  oscillation_window: z.number().int().positive().default(5),
  /** In-cycle: the same tool call with the same arguments this many times ends the cycle. */
  repeated_tool_call: z.number().int().min(2).default(3),
  /**
   * Run-level: this many consecutive cycles that were rejected with no diff, no budget
   * interruption, and no failing check end the run as `stuck` (see guardPre). Autonomous
   * runs are exempt: they park stalled work and move on instead (see recoverNoProgress).
   */
  max_idle_cycles: z.number().int().positive().default(3),
  /** In-cycle: this many turns without a file edit ends the cycle. */
  no_edit_turns: z.number().int().positive().default(15),
  /** In-cycle: tokens above this multiple of the median cycle, with no edit yet, end the cycle. */
  burn_factor: z.number().gt(1).default(3),
  /**
   * In-cycle: no event at all for this long while the agent works (a model call or command that
   * hangs) aborts the cycle, rolls back and counts as a stuck attempt. Longer than
   * budget.max_cmd_timeout, so a slow build is never mistaken for a hang.
   */
  max_silence: durationString.default('45m'),
});

export const contextSchema = z.strictObject({
  /** How each context section reaches the model: pinned, optional (on request) or hidden. */
  sections: sectionsSchema,
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
  /**
   * Rolling memory condensation (the default): every `memory_condense_every` turns the agent
   * rewrites its working memory into a compact note — current goal, active work, decisions,
   * facts with file hashes, open threads, failed attempts — and keeps only `memory_keep_turns`
   * turns raw, so the prompt stays flat over a long run. The raw transcript stays in
   * logs/transcript.md for `recall`. `full` keeps the old behaviour: raw history until the
   * token threshold folds it.
   */
  memory: z.enum(['rolling', 'full']).default('rolling'),
  /** Turns between memory condensations when memory is rolling (6–8). */
  memory_condense_every: z.number().int().min(2).max(20).default(7),
  /** Raw turns kept verbatim after the memory note when memory is rolling. */
  memory_keep_turns: z.number().int().min(1).default(2),
  /**
   * Serve rarely called read-only tools (remember, running_context, recall, outline, read_symbol)
   * through one `more_tools` tool, keeping their schemas out of the cached prefix. Off by default
   * until a bench shows the model still reaches for them when it should.
   */
  lazy_tools: z.boolean().default(false),
  /**
   * The user's context budget (Memory slider, clamped to 85% of the model's window). History is
   * never sent above it: the largest blocks become digests when a fold isn't enough. Unset: no cap.
   */
  budget_tokens: z.number().int().positive().optional(),
  /** `task` subagents: input+output tokens and turns each child may use. */
  subagent_max_tokens: z.number().int().positive().default(150_000),
  subagent_max_turns: z.number().int().positive().default(15),
  /**
   * Whether run agents (worker and planner) get the `task` tool to start helper agents. Off: one
   * agent with the whole context reads for itself (parallel reads in one turn still run at once);
   * on the bench, helpers re-read what the agent then read again.
   */
  subagents: z.boolean().default(false),
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
  /**
   * Chat: answer yes to every "allow this?" question (commands and paths past a guard) instead of
   * asking. Hard-denied commands stay denied. `/yolo` toggles it for one session.
   */
  auto_approve: z.boolean().default(false),
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

export const poolSchema = z.strictObject({
  /**
   * The one ranked provider:model list every role uses unless [roles] gives a role its own
   * (the old models.json, merged into this file). Order is the failover order.
   */
  ranked: z.array(modelRef).max(64).default([]),
  /** How the pool is used: fallback (#1 until its quota runs out), priority (#1 first each call), random. */
  mode: z.enum(['fallback', 'priority', 'random', 'smart']).default('fallback'),
});
export type PoolConfig = z.infer<typeof poolSchema>;

/** Per-role model lists and routing (the old roles.json, merged into this file). */
export const rolesTableSchema = z.strictObject({
  models: z.partialRecord(z.enum(ROLE_NAMES), z.array(modelRef).max(20)).default({}),
  strategies: z.partialRecord(z.enum(ROLE_NAMES), z.enum(STRATEGIES)).default({}),
  spread_helpers: z.boolean().default(true),
});
export type RolesTableConfig = z.infer<typeof rolesTableSchema>;

export const configSchema = z.strictObject({
  /**
   * The user-facing settings live here, in this one file. The essentials — the ones the
   * first-run flow asks about and the settings page shows — are:
   *   provider, model, pool, budget.max_usd, sandbox, policy.auto_approve, experimental.
   * Everything else keeps its default unless a run needs it.
   */
  experimental: z.boolean().default(false),
  /** Default provider (the name of a [providers.endpoints] entry, or "anthropic"). */
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/, 'expected a lowercase provider name')
    .optional(),
  /** Default model for every role when the pool and [roles] say nothing (provider:model). */
  model: modelRef.optional(),
  pool: poolSchema.prefault({}),
  roles: rolesTableSchema.prefault({}),
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
