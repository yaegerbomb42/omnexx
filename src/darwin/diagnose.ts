import type { TurnTrace } from '../telemetry/turn-trace.js';
import type { FailureSymptom } from './types.js';

/**
 * Mines raw turn traces and telemetry events to identify the root cause symptom of a run failure.
 */
export function diagnoseFailure(
  traces: readonly TurnTrace[],
  options?: { lastError?: string; gateFailed?: boolean },
): FailureSymptom | undefined {
  if (traces.length === 0 && !options?.lastError) return undefined;

  // 1. Look for tool errors in the most recent turns
  for (let i = traces.length - 1; i >= 0; i--) {
    const trace = traces[i];
    if (!trace) continue;
    const failedCall = trace.calls.filter((c) => c.isError).at(-1);
    if (failedCall) {
      return {
        turn: trace.turn,
        kind: 'tool_error',
        tool: failedCall.tool,
        detail: failedCall.error || `Tool ${failedCall.tool} failed`,
      };
    }
  }

  // 2. Check for gate failure
  if (options?.gateFailed) {
    const lastTurn = traces.at(-1)?.turn ?? 0;
    return {
      turn: lastTurn,
      kind: 'gate_failure',
      detail: options.lastError ?? 'Verification gates rejected working tree',
    };
  }

  // 3. Fallback on last error if recorded
  if (options?.lastError) {
    return {
      turn: traces.at(-1)?.turn ?? 0,
      kind: /loop|tombstone|oscillation/i.test(options.lastError) ? 'doom_loop' : 'tool_error',
      detail: options.lastError,
    };
  }

  return undefined;
}
