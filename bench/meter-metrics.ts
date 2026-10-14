import type { BenchmarkResult } from './types.ts';
import type { MeterTotals } from './meter.ts';

export type { Meter } from './meter.ts';

/** Bench metrics from the metering proxy: fresh input, cache reads and output, as the endpoint billed them. */
export function meterMetrics(t: MeterTotals, wall_ms: number): BenchmarkResult {
  return {
    resolved: false,
    usd: 0,
    tokens_in: t.prompt - t.cached,
    tokens_out: t.completion,
    cached: t.cached,
    wall_ms,
    interventions: 0,
    requests: t.requests,
  };
}
