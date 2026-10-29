import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EventLog } from './events.js';
import { git } from '../git/git.js';

export interface DoomLoopRatchetOptions {
  worktree: string;
  cleanSha: string;
  events?: EventLog | undefined;
  maxConsecutiveIdenticalErrors?: number | undefined;
  maxVerificationFixTurns?: number | undefined;
  onRollback?: ((rolledBackFiles: string[]) => void | Promise<void>) | undefined;
}

export interface DoomLoopIntervention {
  action: 'none' | 'nudge' | 'rollback';
  reason?: string;
  message?: string;
  rolledBackFiles?: string[];
}

/**
 * Normalizes an error string to create a stable signature invariant to line numbers,
 * timestamps, memory addresses, and execution durations.
 */
export function normalizeErrorSignature(errorContent: string): string {
  return errorContent
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '#sha')
    .replace(/\d+(\.\d+)?\s*(ms|s|m)\b/g, '#time')
    .replace(/:\d+(:\d+)?\b/g, ':#line')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, '#timestamp')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashErrorSignature(
  errorContent: string,
  contextKey = '',
): { hash: string; signature: string } {
  const signature = normalizeErrorSignature(errorContent);
  const hash = createHash('sha256')
    .update(`${contextKey}::${signature}`)
    .digest('hex')
    .slice(0, 16);
  return { hash, signature };
}

/**
 * Breaks the doom loop by:
 * 1. Tracking consecutive identical tool failures and intercepting after 2 strikes.
 * 2. Enforcing "zero partial work" rollback ratchet on verification failures (1 fix turn max, then atomic rollback).
 */
export class DoomLoopRatchet {
  private readonly worktree: string;
  private readonly cleanSha: string;
  private readonly events?: EventLog | undefined;
  private readonly maxConsecutiveErrors: number;
  private readonly onRollback?: ((rolledBackFiles: string[]) => void | Promise<void>) | undefined;

  private lastErrorHash = '';
  private consecutiveErrorCount = 0;
  private readonly dirtyFiles = new Set<string>();
  private verificationStrikes = 0;

  constructor(options: DoomLoopRatchetOptions) {
    this.worktree = resolve(options.worktree);
    this.cleanSha = options.cleanSha;
    this.events = options.events;
    this.maxConsecutiveErrors = options.maxConsecutiveIdenticalErrors ?? 2;
    this.onRollback = options.onRollback;
  }

  get dirtyFileCount(): number {
    return this.dirtyFiles.size;
  }

  get consecutiveFailures(): number {
    return this.consecutiveErrorCount;
  }

  get verificationFailures(): number {
    return this.verificationStrikes;
  }

  get modifiedFiles(): readonly string[] {
    return [...this.dirtyFiles];
  }

  recordFileModified(filePath: string): void {
    const rel = isAbsolute(filePath) ? relative(this.worktree, filePath) : filePath;
    this.dirtyFiles.add(rel);
  }

  recordToolSuccess(): void {
    this.consecutiveErrorCount = 0;
    this.lastErrorHash = '';
  }

  recordToolFailure(
    toolName: string,
    inputSummary: string,
    errorContent: string,
  ): Promise<DoomLoopIntervention> {
    const { hash, signature } = hashErrorSignature(errorContent, `${toolName}:${inputSummary}`);

    if (hash === this.lastErrorHash) {
      this.consecutiveErrorCount++;
    } else {
      this.lastErrorHash = hash;
      this.consecutiveErrorCount = 1;
    }

    if (this.consecutiveErrorCount >= this.maxConsecutiveErrors) {
      const summary = signature.slice(0, 200);
      this.events?.emit('stuck.in_cycle', {
        signal: 'repeated_tool_call',
        detail: `Strategy failed twice with error: ${summary}`,
        turn: 0,
      });

      return Promise.resolve({
        action: 'nudge',
        reason: 'repeated_tool_failure',
        message: `Strategy failed twice with error: "${summary}". Roll back the file and propose an alternative strategy.`,
      });
    }

    return Promise.resolve({ action: 'none' });
  }

  async recordVerificationResult(
    command: string,
    isFailure: boolean,
    output: string,
  ): Promise<DoomLoopIntervention> {
    if (!isFailure) {
      this.verificationStrikes = 0;
      return { action: 'none' };
    }

    // Only apply verification ratchet if there are uncommitted modified files
    if (this.dirtyFiles.size === 0) {
      return { action: 'none' };
    }

    this.verificationStrikes++;

    if (this.verificationStrikes === 1) {
      return {
        action: 'nudge',
        reason: 'verification_failed_strike_1',
        message: `Verification command "${command}" failed on modified files (Strike 1/2). Exactly 1 targeted fix turn is allowed. If verification fails again, changes will be rolled back. Error snippet: ${output.slice(0, 150)}`,
      };
    }

    // Strike 2 or greater: enforce zero partial work rollback ratchet
    const rolledBack = await this.rollbackDirtyFiles();
    this.verificationStrikes = 0;

    return {
      action: 'rollback',
      reason: 'verification_failed_strike_2',
      rolledBackFiles: rolledBack,
      message: `Verification command "${command}" failed twice in a row. Zero partial work rollback ratchet enforced: all modified files [${rolledBack.join(', ')}] have been rolled back to clean state. Never wander into an edit spiral. Propose an alternative strategy.`,
    };
  }

  async rollbackDirtyFiles(): Promise<string[]> {
    const files = [...this.dirtyFiles];
    if (files.length === 0) return [];

    try {
      // Restore files tracked at cleanSha
      await git(this.worktree, ['checkout', this.cleanSha, '--', ...files], { allowFailure: true });
    } catch {
      // If checkout fails (e.g. untracked files), handle individually
    }

    // For any file that was untracked/newly created, unlink it if git checkout didn't reset it
    for (const f of files) {
      const abs = resolve(this.worktree, f);
      try {
        const diff = await git(this.worktree, ['status', '--porcelain', '--', f], {
          allowFailure: true,
        });
        if (diff.stdout.startsWith('??')) {
          await rm(abs, { force: true });
        }
      } catch {
        // Best effort file clean
      }
    }

    this.dirtyFiles.clear();

    if (this.onRollback) {
      await this.onRollback(files);
    }

    return files;
  }
}
