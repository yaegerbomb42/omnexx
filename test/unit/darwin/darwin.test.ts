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

  it('selects the most recent failing call as the root cause', () => {
    const symptom = diagnoseFailure([
      {
        turn: 1,
        calls: [
          { tool: 'read', isError: false, error: '' },
          { tool: 'bash', isError: true, error: 'First failing call' },
          { tool: 'grep', isError: true, error: 'Last failing call' },
        ],
        fresh: 100,
        cached: 0,
        ms: 50,
        gates: 'ok',
      },
    ]);
    expect(symptom).toEqual({
      turn: 1,
      kind: 'tool_error',
      tool: 'grep',
      detail: 'Last failing call',
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

  it('does not misclassify ordinary words containing "loop" as a doom loop', () => {
    for (const lastError of [
      'looping on read',
      'loopback address unreachable',
      'loophole in gate',
      'event loop is blocked',
      'cannot find loop device',
    ]) {
      const symptom = diagnoseFailure(
        [{ turn: 1, calls: [], fresh: 0, cached: 0, ms: 1, gates: 'ok' }],
        { lastError },
      );
      expect(symptom?.kind).toBe('tool_error');
    }
  });

  it('classifies actual doom-loop language as a doom loop', () => {
    for (const lastError of [
      'detected a doom loop',
      'stuck in a tombstone',
      'going through oscillation',
      'doomloop detected',
      'doom loop: repeated same edit',
      'doom_loop',
      'detected doom_loop',
    ]) {
      const symptom = diagnoseFailure(
        [{ turn: 1, calls: [], fresh: 0, cached: 0, ms: 1, gates: 'ok' }],
        { lastError },
      );
      expect(symptom?.kind).toBe('doom_loop');
    }
  });

  // An old failing tool call followed by a clean turn; `gates` is the final turn's gate result.
  const staleToolErrorTraces = (gates: 'ok' | 'fail') => [
    {
      turn: 1,
      calls: [{ tool: 'bash', isError: true, error: 'ancient tool error' }],
      fresh: 10,
      cached: 0,
      ms: 50,
      gates: 'ok' as const,
    },
    {
      turn: 2,
      calls: [{ tool: 'read', isError: false, error: '' }],
      fresh: 20,
      cached: 10,
      ms: 40,
      gates,
    },
  ];

  it.each([
    ['lastError', 'ok', { lastError: 'doom loop: repeated same read' }, 'doom_loop'],
    [
      'gateFailed',
      'fail',
      { gateFailed: true, lastError: 'Unit tests failed: 2 broken' },
      'gate_failure',
    ],
  ] as const)('prefers newer %s signal over an ancient tool error', (_n, gates, options, kind) => {
    expect(diagnoseFailure(staleToolErrorTraces(gates), options)).toEqual({
      turn: 2,
      kind,
      detail: options.lastError,
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

  it('reverts when runGates rejects and rethrows the original error', async () => {
    let reverted = false;
    const boom = new Error('gate runner crashed');
    const sandbox: SandboxRunner = {
      runGates: () => Promise.reject(boom),
      revert: () => {
        reverted = true;
        return Promise.resolve();
      },
      commit: () => Promise.resolve(''),
    };

    const symptom: FailureSymptom = { turn: 1, kind: 'tool_error', detail: 'SyntaxError' };
    const mutation: MutationProposal = {
      target: 'prompt',
      file: 'src/instructions/base.ts',
      rationale: 'Clarify JSON schema requirements',
      diffPatch: '+ Ensure JSON is escaped',
    };

    await expect(evaluateMutation(1, symptom, mutation, sandbox)).rejects.toBe(boom);
    expect(reverted).toBe(true);
  });

  it('reverts when commit rejects and rethrows the original error', async () => {
    let reverted = false;
    const boom = new Error('commit failed');
    const sandbox: SandboxRunner = {
      runGates: () => Promise.resolve({ ok: true }),
      revert: () => {
        reverted = true;
        return Promise.resolve();
      },
      commit: () => Promise.reject(boom),
    };

    const symptom: FailureSymptom = { turn: 1, kind: 'tool_error', detail: 'SyntaxError' };
    const mutation: MutationProposal = {
      target: 'prompt',
      file: 'src/instructions/base.ts',
      rationale: 'Clarify JSON schema requirements',
      diffPatch: '+ Ensure JSON is escaped',
    };

    await expect(evaluateMutation(1, symptom, mutation, sandbox)).rejects.toBe(boom);
    expect(reverted).toBe(true);
  });
});
