import type { Reading } from './parse.ts';

export interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
}

export function summarize(readings: Reading[]): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (const r of readings) {
    const s = out[r.sensor] ?? { count: 0, min: Infinity, max: -Infinity, mean: 0 };
    const count = s.count + 1;
    out[r.sensor] = {
      count,
      min: Math.min(s.min, r.value),
      max: Math.max(s.max, r.value),
      mean: s.mean + (r.value - s.mean) / count,
    };
  }
  return out;
}
