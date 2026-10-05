import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import type { BenchmarkResult, TaskDef, TaskRunResult } from '../types.js';

/** Abstract base class for agent runners. */
export abstract class AgentRunner {
  protected constructor(protected readonly name: string) {}

  /** The agent name (e.g., 'omnexx', 'claude-code', 'codex'). */
  get agentName(): string {
    return this.name;
  }

  /**
   * Run the agent on a single task.
   * @param task The task definition.
   * @param workDir The working directory for the task (already set up by the suite).
   * @returns Benchmark metrics for the run.
   */
  abstract run(task: TaskDef, workDir: string): Promise<BenchmarkResult>;

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
    const child = spawn(command, args, spawnOptions);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      setTimeout(() => {
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    const exitPromise = once(child, 'exit').then(([code]: unknown[]) => ({
      timedOut: false as const,
      exitCode: code as number | null,
    }));

    const result = await Promise.race([timeoutPromise, exitPromise]);

    if (result.timedOut) {
      // Kill the process group
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        process.kill(-child.pid!, 'SIGKILL');
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
  protected parseJsonLine(line: string): unknown | null {
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
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
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
