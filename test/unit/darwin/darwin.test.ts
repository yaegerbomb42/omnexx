import { describe, expect, it } from 'vitest';
import { diagnoseFailure } from '../../../src/darwin/diagnose.js';
import { evaluateMutation, type SandboxRunner } from '../../../src/darwin/ratchet.js';
import type { FailureSymptom, MutationProposal } from '../../../src/darwin/types.js';

describe('darwinx meta-harness', () => {
  it('diagnoses tool error from recent traces', () => {
    const symptom = diagnoseFailure([
      {
        turn: 1,
        calls: [{ tool: 'read', isError: false, error: '' }],
        fresh: 100,
        cached: 0,
        ms: 50,
        gates: 'ok',
      },
      {
        turn: 2,
        calls: [{ tool: 'bash', isError: true, error: 'Command denied: rm -rf' }],
        fresh: 50,
        cached: 100,
        ms: 100,
        gates: 'fail',
      },
    ]);
    expect(symptom).toEqual({
      turn: 2,
      kind: 'tool_error',
      tool: 'bash',
      detail: 'Command denied: rm -rf',
    });
  });

  it('diagnoses gate failures when flagged', () => {
    const symptom = diagnoseFailure(
      [{ turn: 3, calls: [], fresh: 10, cached: 50, ms: 20, gates: 'fail' }],
      { gateFailed: true, lastError: 'Unit tests failed: 2 broken' },
    );
    expect(symptom).toMatchObject({
      turn: 3,
      kind: 'gate_failure',
      detail: 'Unit tests failed: 2 broken',
    });
  });

  it('ratchets accepted mutation when gates pass', async () => {
    const commits: string[] = [];
    const sandbox: SandboxRunner = {
      runGates: () => Promise.resolve({ ok: true }),
      revert: () => Promise.resolve(),
      commit: (msg) => {
        commits.push(msg);
        return Promise.resolve('commit-sha');
      },
    };

    const symptom: FailureSymptom = { turn: 1, kind: 'tool_error', detail: 'SyntaxError' };
    const mutation: MutationProposal = {
      target: 'prompt',
      file: 'src/instructions/base.ts',
      rationale: 'Clarify JSON schema requirements',
      diffPatch: '+ Ensure JSON is escaped',
    };

    const res = await evaluateMutation(1, symptom, mutation, sandbox);
    expect(res.status).toBe('accepted');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain('darwin(gen-1)');
  });

  it('atomically reverts mutation when regression occurs', async () => {
    let reverted = false;
    const sandbox: SandboxRunner = {
      runGates: () => Promise.resolve({ ok: false, failureReason: 'test:quick failed' }),
      revert: () => {
        reverted = true;
        return Promise.resolve();
      },
      commit: () => Promise.resolve(''),
    };

    const symptom: FailureSymptom = { turn: 2, kind: 'doom_loop', detail: 'Looping on read' };
    const mutation: MutationProposal = {
      target: 'config',
      file: 'src/config/schema.ts',
      rationale: 'Adjust compact_at threshold',
      diffPatch: '+ compact_at: 1000',
    };

    const res = await evaluateMutation(2, symptom, mutation, sandbox);
    expect(res.status).toBe('rejected');
    expect(reverted).toBe(true);
    expect(res.rejectionReason).toBe('test:quick failed');
  });
});
