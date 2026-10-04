import { randomBytes } from 'node:crypto';

/** `r_20261003_1834_ab12`: sortable by start time, unique enough for one machine. */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  return `r_${stamp}_${randomBytes(2).toString('hex')}`;
}

export const RUN_ID_RE = /^r_\d{8}_\d{4}_[0-9a-f]{4}$/;
