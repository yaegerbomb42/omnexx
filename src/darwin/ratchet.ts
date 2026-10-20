import type { FailureSymptom, MutationProposal, EvolutionResult } from './types.js';

export interface SandboxRunner {
  runGates(): Promise<{ ok: boolean; failureReason?: string }>;
  revert(): Promise<void>;
  commit(message: string): Promise<string>;
}

/**
 * Validates a proposed self-mutation inside a sandboxed environment against regression gates.
 * If tests pass, commits and ratchets forward; if anything breaks, executes an atomic rollback.
 */
export async function evaluateMutation(
  generation: number,
  symptom: FailureSymptom,
  mutation: MutationProposal,
  sandbox: SandboxRunner,
): Promise<EvolutionResult> {
  const result = await sandbox.runGates();

  if (result.ok) {
    await sandbox.commit(
      `darwin(gen-${generation}): adapt ${mutation.target} for ${symptom.kind} (${symptom.detail.slice(0, 50)})`,
    );
    return {
      generation,
      symptom,
      mutation,
      status: 'accepted',
    };
  }

  // Regression detected: rollback atomically
  await sandbox.revert();
  return {
    generation,
    symptom,
    mutation,
    status: 'rejected',
    rejectionReason: result.failureReason ?? 'Regression gate failed',
  };
}
