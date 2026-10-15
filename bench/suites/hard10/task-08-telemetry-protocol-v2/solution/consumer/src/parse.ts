export type Unit = 'C' | 'F' | 'K';

/** A reading normalized to Celsius and epoch milliseconds. */
export interface Reading {
  sensor: string;
  ts: number;
  value: number | null;
}

const UNITS: Record<Unit, (v: number) => number> = {
  C: (v) => v,
  F: (v) => ((v - 32) * 5) / 9,
  K: (v) => v - 273.15,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function v1(o: Record<string, unknown>): Reading | null {
  if (typeof o.sensor !== 'string' || typeof o.ts !== 'number' || typeof o.value !== 'number') return null;
  return { sensor: o.sensor, ts: o.ts * 1000, value: o.value };
}

function v2(o: Record<string, unknown>): Reading | null {
  const unit = o.unit as Unit;
  if (typeof o.sensor !== 'string' || typeof o.ts !== 'string' || !(unit in UNITS)) return null;
  if (o.value !== null && typeof o.value !== 'number') return null;
  const ts = Date.parse(o.ts);
  if (Number.isNaN(ts)) return null;
  return { sensor: o.sensor, ts, value: o.value === null ? null : UNITS[unit](o.value) };
}

/** A reading, or null when the line is not valid v1/v2. */
export function parseLine(line: string): Reading | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  if (!('v' in o)) return v1(o);
  return o.v === 2 ? v2(o) : null;
}
