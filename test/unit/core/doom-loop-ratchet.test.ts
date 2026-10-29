import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DoomLoopRatchet,
  hashErrorSignature,
  normalizeErrorSignature,
} from '../../../src/core/doom-loop-ratchet.js';
import { git } from '../../../src/git/git.js';
import { tempRepo } from '../../support/tmp.js';

describe('normalizeErrorSignature & hashErrorSignature', () => {
  it('normalizes line numbers, durations, hex hashes, and timestamps', () => {
    const error1 = 'Error in file.ts:42:15 at 0x7fff89ab after 150ms [2026-10-28T14:00:00Z]: cannot find name';
    const error2 = 'Error in file.ts:99:10 at 0x1234abcd after 2.5s [2026-10-28T14:05:00Z]: cannot find name';

    expect(normalizeErrorSignature(error1)).toBe(normalizeErrorSignature(error2));

    const hash1 = hashErrorSignature(error1, 'bash:npm test');
    const hash2 = hashErrorSignature(error2, 'bash:npm test');
    expect(hash1.hash).toBe(hash2.hash);
  });
});

describe('DoomLoopRatchet - repeated tool failure deduplication', () => {
  it('intercepts after 2 consecutive identical tool failures with a strategy nudge', async () => {
    const repo = await tempRepo();
    const ratchet = new DoomLoopRatchet({
      worktree: repo,
      cleanSha: 'HEAD',
    });

    const error = 'SyntaxError: Unexpected token < at 12ms';

    // Strike 1
    const res1 = await ratchet.recordToolFailure('bash', 'npm test', error);
    expect(res1.action).toBe('none');
    expect(ratchet.consecutiveFailures).toBe(1);

    // Strike 2 (identical error)
    const res2 = await ratchet.recordToolFailure('bash', 'npm test', error);
    expect(res2.action).toBe('nudge');
    expect(res2.reason).toBe('repeated_tool_failure');
    expect(res2.message).toContain('Strategy failed twice with error');
    expect(ratchet.consecutiveFailures).toBe(2);
  });

  it('resets consecutive failure counter on different error or success', async () => {
    const repo = await tempRepo();
    const ratchet = new DoomLoopRatchet({
      worktree: repo,
      cleanSha: 'HEAD',
    });

    await ratchet.recordToolFailure('bash', 'npm test', 'Error A');
    expect(ratchet.consecutiveFailures).toBe(1);

    // Different error resets count to 1
    await ratchet.recordToolFailure('bash', 'npm test', 'Error B');
    expect(ratchet.consecutiveFailures).toBe(1);

    // Success resets count to 0
    ratchet.recordToolSuccess();
    expect(ratchet.consecutiveFailures).toBe(0);
  });
});

describe('DoomLoopRatchet - zero partial work rollback ratchet', () => {
  it('allows 1 targeted fix turn, then rolls back dirty files on strike 2', async () => {
    const repo = await tempRepo();
    const testFile = join(repo, 'math.js');
    await writeFile(testFile, 'export const val = 1;\n');
    await git(repo, ['add', 'math.js']);
    await git(repo, ['commit', '-m', 'initial']);
    const headSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    const rolledBackCalls: string[][] = [];
    const ratchet = new DoomLoopRatchet({
      worktree: repo,
      cleanSha: headSha,
      onRollback: (files) => {
        rolledBackCalls.push(files);
      },
    });

    // Modify file
    await writeFile(testFile, 'export const val = 999; // breaking change\n');
    ratchet.recordFileModified('math.js');
    expect(ratchet.dirtyFileCount).toBe(1);

    // Strike 1: verification fails
    const strike1 = await ratchet.recordVerificationResult('npm test', true, 'Assertion failed: expected 1 got 999');
    expect(strike1.action).toBe('nudge');
    expect(strike1.reason).toBe('verification_failed_strike_1');
    expect(strike1.message).toContain('Strike 1/2');
    expect(strike1.message).toContain('Exactly 1 targeted fix turn is allowed');
    expect(ratchet.verificationFailures).toBe(1);
    expect(await readFile(testFile, 'utf8')).toContain('999'); // Still modified

    // Strike 2: verification fails again -> rollback ratchet fires!
    const strike2 = await ratchet.recordVerificationResult('npm test', true, 'Assertion failed: expected 1 got 999');
    expect(strike2.action).toBe('rollback');
    expect(strike2.reason).toBe('verification_failed_strike_2');
    expect(strike2.message).toContain('Zero partial work rollback ratchet enforced');
    expect(strike2.rolledBackFiles).toEqual(['math.js']);
    expect(rolledBackCalls).toEqual([['math.js']]);
    expect(ratchet.dirtyFileCount).toBe(0);
    expect(ratchet.verificationFailures).toBe(0);

    // The file should now be rolled back to its clean initial state
    const restoredContent = await readFile(testFile, 'utf8');
    expect(restoredContent).toBe('export const val = 1;\n');
  });

  it('resets verification strikes if fix turn succeeds', async () => {
    const repo = await tempRepo();
    const testFile = join(repo, 'math.js');
    await writeFile(testFile, 'export const val = 1;\n');
    await git(repo, ['add', 'math.js']);
    await git(repo, ['commit', '-m', 'initial']);
    const headSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    const ratchet = new DoomLoopRatchet({
      worktree: repo,
      cleanSha: headSha,
    });

    ratchet.recordFileModified('math.js');

    // Strike 1 fails
    await ratchet.recordVerificationResult('npm test', true, 'fail');
    expect(ratchet.verificationFailures).toBe(1);

    // Fix turn succeeds
    const pass = await ratchet.recordVerificationResult('npm test', false, 'all passed');
    expect(pass.action).toBe('none');
    expect(ratchet.verificationFailures).toBe(0);
  });
});
