import { z } from 'zod';

/**
 * [autonomous]: two surfaces share this table.
 *
 * `run --for 8h` keeps improving the repo until the clock runs out (enabled, max_idle_rounds,
 * focus). The 24/7 daemon (`omnexx daemon start`) is the same idea without a clock: it
 * discovers work, queues it, works it on `target_branch` and asks a human to approve the
 * diff before it lands. The daemon reads the `discovery`, `circuit_breakers`, `budget`,
 * `verification` and `safety` subtables; the run surface ignores them.
 */
/**
 * The nine discovery collectors (see src/autonomous/discovery/index.ts, ALL_COLLECTORS).
 * The names are the contract: [autonomous.discovery] collectors_enabled filters them.
 */
export const AUTONOMOUS_COLLECTORS = [
  'test_runner',
  'static_analysis',
  'self_review',
  'coverage_churn',
  'dependency',
  'telemetry',
  'perf_benchmark',
  'complexity',
  'todo_mining',
] as const;
export type AutonomousCollector = (typeof AUTONOMOUS_COLLECTORS)[number];

/**
 * Paths a daemon task may never touch, even with an explicit instruction. Mirrors the
 * repo-wide protected list (see DEFAULT_PROTECTED in schema.ts) plus the daemon's own
 * state, so a task cannot rewrite its queue, its config, or the release pipeline.
 */
export const AUTONOMOUS_IMMUTABLE_PATHS = [
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
  '.omnexx/**',
];

const discoverySchema = z.strictObject({
  /** Seconds between discovery passes while the daemon is idle. */
  interval_sec: z.number().int().positive().default(300),
  /** Backoff cap when a collector keeps failing (exponential, to this ceiling). */
  max_backoff_sec: z.number().int().positive().default(3600),
  /** A candidate below this priority score never enters the queue. */
  min_priority_score: z.number().default(32.0),
  /** The queue stops accepting new work past this depth. */
  max_queue_depth: z.number().int().positive().default(50),
  /** Which collectors run; an empty list discovers nothing. */
  collectors_enabled: z.array(z.enum(AUTONOMOUS_COLLECTORS)).default([...AUTONOMOUS_COLLECTORS]),
  /** Dependabot-style collectors skip packages younger than this. */
  min_package_age_days: z.number().int().nonnegative().default(7),
});

const circuitBreakersSchema = z.strictObject({
  /** Turns of agent work before a task is parked as stuck. */
  max_turns_per_task: z.number().int().positive().default(25),
  /** Wall-clock seconds before a task is parked as stuck. */
  max_wall_clock_per_task_sec: z.number().int().positive().default(1800),
  /** The same tool error this many times in a row trips the breaker. */
  max_identical_tool_errors: z.number().int().positive().default(3),
  /** Identical read-only tool calls in this window count as a loop. */
  tree_cycle_window_size: z.number().int().positive().default(6),
  /** Read-only turns in a row (no edit) before the task is parked. */
  max_read_only_streak: z.number().int().positive().default(6),
  /** Seconds with no tool call or output before the watchdog kills the task. */
  watchdog_stall_timeout_sec: z.number().int().positive().default(300),
  /** First tombstone on a task signature: no retry for this long. */
  tombstone_strike1_cooldown_hours: z.number().int().positive().default(24),
  /** Second tombstone on the same signature: no retry for this long. */
  tombstone_strike2_cooldown_hours: z.number().int().positive().default(168),
});

const autonomousBudgetSchema = z.strictObject({
  /** Soft per-task token cap: the task wraps up instead of starting new work. */
  max_tokens_per_task_soft: z.number().int().positive().default(120_000),
  /** Hard per-task token cap: the task is parked at once. */
  max_tokens_per_task_hard: z.number().int().positive().default(150_000),
  /** Per-task spend cap in USD. */
  max_cost_usd_per_task: z.number().positive().default(0.5),
  /** Rolling one-hour token cap across all daemon work. */
  max_tokens_per_hour: z.number().int().positive().default(1_000_000),
  /** Rolling one-hour spend cap in USD. */
  max_cost_usd_per_hour: z.number().positive().default(3.0),
  /** Rolling 24-hour token cap across all daemon work. */
  max_tokens_per_day: z.number().int().positive().default(10_000_000),
  /** Rolling 24-hour spend cap in USD. */
  max_cost_usd_per_day: z.number().positive().default(25.0),
  /** Spend on tasks that produce nothing before the daemon pauses for a human. */
  max_unproductive_spend_usd: z.number().positive().default(2.5),
});

const verificationSchema = z.strictObject({
  /** A fix must ship with a test that fails without it and passes with it. */
  require_revert_test_proof: z.boolean().default(true),
  /** Every finished task goes through an adversarial critic before review. */
  require_adversarial_critic: z.boolean().default(true),
  /** Critic scores are 1-5; below this the diff goes back for rework. */
  critic_min_score: z.number().int().min(1).max(5).default(4),
  /** Diffs at or below this risk score may auto-merge; above it a human must approve. */
  auto_merge_max_risk_score: z.number().int().min(0).max(100).default(25),
  /** After this many finished tasks, a macro audit re-runs the whole suite. */
  macro_audit_every_n_tasks: z.number().int().positive().default(10),
  /** Re-runs of a failing gate to tell a flake from a real failure. */
  flake_isolation_reruns: z.number().int().min(0).max(5).default(3),
});

const safetySchema = z.strictObject({
  /** A task may touch at most this many files. */
  max_files_per_task: z.number().int().positive().default(6),
  /** A task may add at most this many net lines of code. */
  max_net_loc_per_task: z.number().int().positive().default(150),
  /** Bash inside a daemon task may not reach the network. */
  allow_network_in_bash: z.boolean().default(false),
  /** Paths a daemon task may never touch (see AUTONOMOUS_IMMUTABLE_PATHS). */
  immutable_paths: z.array(z.string()).default([...AUTONOMOUS_IMMUTABLE_PATHS]),
});

export const autonomous = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** "daemon": run until stopped; "bounded": stop after the run budget (see [budget]). */
    mode: z.enum(['daemon', 'bounded']).default('daemon'),
    /** Branch daemon work lands on for review (never main directly). */
    target_branch: z.string().default('omnexx/auto-main'),
    /** Branch daemon work is based on. */
    base_branch: z.string().default('main'),
    /** Where per-task worktrees live, relative to the repo root. */
    worktree_dir: z.string().default('.omnexx/worktrees'),
    /** SQLite state (work queue, tombstones, budget ledger), relative to the repo root. */
    state_db_path: z.string().default('.omnexx/autonomous.db'),
    /** Mirror daemon state into git notes on the target branch. */
    sync_git_notes: z.boolean().default(true),
    /** Rounds in a row that may add nothing before a `run --for` run decides the repo is done. */
    max_idle_rounds: z.number().int().min(1).max(50).default(8),
    /** Extra focus areas, tried before the built-in rubric (e.g. "port the CLI to Rust"). */
    focus: z.array(z.string().min(1)).default([]),
    discovery: discoverySchema.prefault({}),
    circuit_breakers: circuitBreakersSchema.prefault({}),
    budget: autonomousBudgetSchema.prefault({}),
    verification: verificationSchema.prefault({}),
    safety: safetySchema.prefault({}),
  })
  .prefault({});

export type AutonomousConfig = z.infer<typeof autonomous>;
