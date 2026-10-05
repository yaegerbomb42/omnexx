import type { Baseline } from '../core/run-store.js';
import type { GateResult } from './gates.js';

export interface GateVerdict {
  gate: string;
  pass: boolean;
  reason?: string;
  newFailures: string[];
  fixed: string[];
}

/**
 * must-pass: exit 0 and no timeout. ratchet: no failure id that wasn't already failing, and
 * the failure count can't go up. A gate missing from the baseline is judged as must-pass.
 */
export function judgeGate(result: GateResult, baseline: Baseline | undefined): GateVerdict {
  const base = baseline?.[result.name];
  const ids = result.failures.map((f) => f.id);
  const baseIds = new Set(base?.failureIds ?? []);
  const newFailures = [...new Set(ids.filter((id) => !baseIds.has(id)))];
  const currentIds = new Set(ids);
  const fixed = [...baseIds].filter((id) => !currentIds.has(id));
  const verdict = (pass: boolean, reason?: string): GateVerdict => ({
    gate: result.name,
    pass,
    ...(reason ? { reason } : {}),
    newFailures,
    fixed,
  });
  if (result.timedOut) return verdict(false, 'timed out');
  if (result.level === 'must-pass' || !base) {
    return result.exitCode === 0 ? verdict(true) : verdict(false, `exit ${result.exitCode}`);
  }
  if (result.exitCode !== 0 && base.exitCode === 0)
    return verdict(false, `exit ${result.exitCode}; passed at baseline`);
  if (newFailures.length) return verdict(false, `${newFailures.length} new failure(s)`);
  if (ids.length > base.failureIds.length)
    return verdict(false, `failures rose from ${base.failureIds.length} to ${ids.length}`);
  return verdict(true);
}

/** Normalized failure signature: what failed, independent of line numbers, hex ids and durations. */
export function failureSignature(parts: readonly string[]): string {
  const norm = parts
    .map((p) =>
      p
        .replace(/0x[0-9a-f]+/gi, '0x#')
        .replace(/\b[0-9a-f]{7,40}\b/gi, '#sha')
        .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '#t')
        .replace(/:\d+(:\d+)?/g, ':#')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .sort();
  return norm.join(' | ');
}
