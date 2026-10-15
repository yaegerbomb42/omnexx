export interface Reading {
  sensor: string;
  ts: number;
  value: number;
}

export function parseLine(line: string): Reading {
  const o = JSON.parse(line) as Reading;
  return { sensor: o.sensor, ts: o.ts, value: o.value };
}
