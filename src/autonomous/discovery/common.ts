import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Result of a best-effort shell command: never throws, always reports what happened. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run a command with a timeout. Returns a result object instead of throwing on
 * non-zero exit or timeout so collectors can degrade gracefully.
 *
 * The child runs in its own process group (`detached: true`) and a timeout
 * kills the WHOLE group with SIGKILL: tools like vitest spawn worker
 * grandchildren that would otherwise survive a SIGTERM to the direct child,
 * hold the stdio pipes open, and hang the caller forever.
 */
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  let timedOut = false;
  try {
    const child = execa(command, args, {
      cwd,
      reject: false,
      stdin: 'ignore',
      maxBuffer: 64 * 1024 * 1024,
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);
    timer.unref();
    try {
      const result = await child;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? null,
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { stdout: '', stderr: String(err), exitCode: null, timedOut };
  }
}

/** SIGKILL the child's process group, falling back to the child itself. */
function killProcessGroup(child: {
  pid?: number;
  kill: (signal: NodeJS.Signals) => boolean;
}): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Process group already gone; fall through to killing the child directly.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already dead.
  }
}

/** Run a git command; returns trimmed stdout or '' on any failure. */
export async function git(repoRoot: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const result = await runCommand('git', args, repoRoot, timeoutMs);
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Parse JSON without throwing; returns undefined on bad input. Callers cast the result. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return safeJsonParse(await readFile(path, 'utf8')) as T | undefined;
  } catch {
    return undefined;
  }
}

export function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function joinRoot(repoRoot: string, ...parts: string[]): string {
  return join(repoRoot, ...parts);
}

/** Stable fingerprint for a finding, used for dedupe and self-repair attempt bounding. */
export function fingerprint(parts: string[]): string {
  return parts.join('|');
}

/**
 * Files changed (tracked) in the working tree or index, relative to HEAD.
 * Capped so a huge dirty tree can't blow up downstream work.
 */
export async function changedFiles(repoRoot: string, limit = 100): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--name-only', 'HEAD']);
  const staged = await git(repoRoot, ['diff', '--name-only', '--cached']);
  const seen = new Set<string>();
  for (const line of `${out}\n${staged}`.split('\n')) {
    const file = line.trim();
    if (file) seen.add(file);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Parse `git log --numstat` output into per-file churn (added + deleted lines). */
export function parseNumstat(output: string): Map<string, number> {
  const churn = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const added = match[1] === '-' ? 0 : Number(match[1]);
    const deleted = match[2] === '-' ? 0 : Number(match[2]);
    const file = match[3] as string;
    churn.set(file, (churn.get(file) ?? 0) + added + deleted);
  }
  return churn;
}

/** Parse `git log --numstat` into per-file commit counts (how many commits touched each file). */
export function parseNumstatCommits(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  const seenInCommit = new Set<string>();
  let inCommit = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('commit ')) {
      seenInCommit.clear();
      inCommit = true;
      continue;
    }
    if (!inCommit) continue;
    const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const file = match[1] as string;
    if (seenInCommit.has(file)) continue;
    seenInCommit.add(file);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}
