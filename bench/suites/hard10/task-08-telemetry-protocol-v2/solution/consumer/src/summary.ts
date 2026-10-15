import type { Reading } from './parse.ts';

export interface Stats {
  count: number;
  missing: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  first: string;
  last: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function stats(rs: Reading[]): Stats {
  const values = rs.map((r) => r.value).filter((v): v is number => v !== null);
  const times = rs.map((r) => r.ts);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    missing: rs.length - values.length,
    min: values.length ? round2(Math.min(...values)) : null,
    max: values.length ? round2(Math.max(...values)) : null,
    mean: values.length ? round2(sum / values.length) : null,
    first: new Date(Math.min(...times)).toISOString(),
    last: new Date(Math.max(...times)).toISOString(),
  };
}

export function summarize(readings: Reading[]): Record<string, Stats> {
  const groups = new Map<string, Reading[]>();
  for (const r of readings) groups.set(r.sensor, [...(groups.get(r.sensor) ?? []), r]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, stats(groups.get(k) ?? [])]));
}
