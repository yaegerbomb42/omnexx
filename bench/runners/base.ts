import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import type { AgentRunOutput, BenchmarkResult, TaskDef, TaskRunResult } from '../types.ts';

/** Abstract base class for agent runners. */
export abstract class AgentRunner {
  protected readonly name: string;
  /** When set, everything the agent prints is appended here as it happens (bench:watch). */
  liveLog: string | undefined;

  protected constructor(name: string) {
    this.name = name;
  }

  /** The agent name (e.g., 'omnexx', 'claude-code', 'codex'). */
  get agentName(): string {
    return this.name;
  }

  /**
   * Run the agent on a single task.
   * @param task The task definition.
   * @param workDir The working directory for the task (already set up by the suite).
   * @param goal The task prompt.
   * @returns Metrics, plus `resultDir` when the agent's work lands somewhere other than
   * `workDir` (omnexx commits in its own worktree). The harness, not the runner, decides `resolved`.
   */
  abstract run(task: TaskDef, workDir: string, goal: string): Promise<AgentRunOutput>;

  /**
   * Check if this agent is available on the system.
   * @returns true if the agent binary/command exists and meets version requirements.
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Spawn a child process and collect output with timeout.
   */
  protected async spawnWithTimeout(
    command: string,
    args: string[],
    options: SpawnOptions & { timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, { detached: true, ...spawnOptions });

    let stdout = '';
    let stderr = '';

    const tee = (text: string): void => {
      if (!this.liveLog) return;
      try {
        appendFileSync(this.liveLog, text);
      } catch {
        // Watching is best-effort; the run never fails over its live log.
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      tee(chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      tee(chunk.toString());
    });

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    const exitPromise = once(child, 'exit').then(([code]: unknown[]) => ({
      timedOut: false as const,
      exitCode: code as number | null,
    }));

    const result = await Promise.race([timeoutPromise, exitPromise]);
    // A pending timer keeps node alive for the rest of the cap after the run has finished.
    clearTimeout(timer);

    if (result.timedOut) {
      // Kill the process group
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Process already dead
      }
      await once(child, 'exit');
      return { stdout, stderr, exitCode: null, timedOut: true };
    }

    return { stdout, stderr, exitCode: result.exitCode, timedOut: false };
  }

  /**
   * Parse a JSON line from output (for --json flags).
   */
  protected parseJsonLine(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

/** Result builder for creating TaskRunResult with timestamps. */
export function createTaskRunResult(
  task: TaskDef,
  agent: string,
  metrics: BenchmarkResult,
  error?: string,
): TaskRunResult {
  const finishedAt = new Date().toISOString();
  // startedAt is approximated as finishedAt minus wall_ms
  const startedAt = new Date(Date.now() - metrics.wall_ms).toISOString();
  return {
    taskId: task.id,
    suite: task.path.split('/')[0] ?? 'unknown',
    agent,
    metrics,
    startedAt,
    finishedAt,
    error: error ?? '',
  };
}
