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

  // A gate/last-error signal reflects the terminal outcome after the final tool
  // call of the run, so it is chronologically newer than any tool error earlier in
  // history. Check it before the tool-error scan so a stale (ancient) tool error
  // never masks the newer signal.
  const lastTurn = traces.at(-1)?.turn ?? 0;
  if (options?.gateFailed) {
    return {
      turn: lastTurn,
      kind: 'gate_failure',
      detail: options.lastError ?? 'Verification gates rejected working tree',
    };
  }
  if (options?.lastError) {
    return {
      turn: lastTurn,
      kind: /doom[\s_-]?loop|\b(stuck|repeat(ed|ing)?|oscillat\w*|tombstone)\b/i.test(
        options.lastError,
      )
        ? 'doom_loop'
        : 'tool_error',
      detail: options.lastError,
    };
  }

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

  return undefined;
}
