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

/**
 * Efficiency metrics of one bench run, compared against a recorded baseline by `judgeEfficiency`.
 * tokensPerTask counts fresh tokens (uncached input + cache writes + output); latency is the p95
 * over the model calls of every task, so both are comparable across machines and runs.
 */
export interface EfficiencyMetrics {
  tokensPerTask: number;
  turnsPerTask: number;
  p95LatencyMs: number;
}

/** The committed baseline `npm run bench:efficiency` ratchets against (bench/efficiency-baseline.json). */
export interface EfficiencyBaseline {
  version: 1;
  fixture: string;
  recordedAt: string;
  metrics: EfficiencyMetrics;
}

export interface EfficiencyVerdict {
  pass: boolean;
  reason?: string;
  /** Every metric that regressed beyond the threshold, with the delta in percent. */
  regressions: {
    metric: keyof EfficiencyMetrics;
    baseline: number;
    measured: number;
    deltaPct: number;
  }[];
}

/** Nearest-rank 95th percentile of `values`; 0 when empty. */
export function p95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * Ratchet the measured efficiency against the baseline: a metric that regressed by more than
 * `thresholdPct` fails the bench. A missing baseline records one instead of failing, so the
 * first run on a machine bootstraps and CI ratchets against the committed baseline.
 */
export function judgeEfficiency(
  measured: EfficiencyMetrics,
  baseline: EfficiencyBaseline | undefined,
  thresholdPct = 5,
): EfficiencyVerdict {
  if (!baseline)
    return { pass: true, reason: 'no baseline yet: this run records one', regressions: [] };
  const regressions: EfficiencyVerdict['regressions'] = [];
  for (const metric of ['tokensPerTask', 'turnsPerTask', 'p95LatencyMs'] as const) {
    const b = baseline.metrics[metric];
    if (b <= 0) continue;
    const m = measured[metric];
    if (m > b * (1 + thresholdPct / 100)) {
      regressions.push({
        metric,
        baseline: b,
        measured: m,
        deltaPct: Number(((m / b - 1) * 100).toFixed(1)),
      });
    }
  }
  return regressions.length
    ? {
        pass: false,
        reason: `${regressions.length} efficiency metric(s) regressed past ${thresholdPct}%`,
        regressions,
      }
    : { pass: true, regressions: [] };
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
