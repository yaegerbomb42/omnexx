/** Benchmark types shared across runners, suites, and results. */

export interface BenchmarkResult {
  /** Whether the agent successfully resolved the task. */
  resolved: boolean;
  /** Total cost in USD. */
  usd: number;
  /** Input tokens (uncached). */
  tokens_in: number;
  /** Output tokens. */
  tokens_out: number;
  /** Cached input tokens. */
  cached: number;
  /** Wall-clock time in milliseconds. */
  wall_ms: number;
  /** Number of human interventions required. */
  interventions: number;
}

/** Result of running a single task with an agent. */
export interface TaskRunResult {
  /** Task identifier. */
  taskId: string;
  /** Suite name this task belongs to. */
  suite: string;
  /** Agent name (e.g., 'omnexx', 'claude-code', 'codex'). */
  agent: string;
  /** Benchmark metrics. */
  metrics: BenchmarkResult;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run finished. */
  finishedAt: string;
  /** Error message if the run failed catastrophically (not a task failure). */
  error?: string;
}

/** Configuration for a benchmark run. */
export interface BenchConfig {
  /** Suite to run: 'jimmy10' | 'lite50' | 'longspec'. */
  suite: string;
  /** Comma-separated list of agents to run. */
  agents: string[];
  /** Output directory for results. */
  out: string;
}

/** A task definition in a suite. */
export interface TaskDef {
  /** Unique task ID. */
  id: string;
  /** Path to the task directory (relative to suite root). */
  path: string;
  /** Human-readable description. */
  description: string;
}

/** A benchmark suite. */
export interface Suite {
  /** Suite name. */
  name: string;
  /** Load all tasks in this suite. */
  loadTasks(): Promise<TaskDef[]>;
  /** Set up a single task (clone repo, run setup script, etc.). */
  setupTask(task: TaskDef, workDir: string): Promise<void>;
  /** Get the goal/markdown for a task. */
  getGoal(task: TaskDef): Promise<string>;
  /** Run the hidden check command for a task and return whether it passes. */
  checkTask(task: TaskDef, workDir: string): Promise<boolean>;
}
