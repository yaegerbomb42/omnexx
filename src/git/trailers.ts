export interface OmnexxTrailers {
  run: string;
  task: string;
  cycle: number;
  worker?: string;
}

export function formatTrailers(t: OmnexxTrailers): string {
  const lines = [`Omnexx-Run: ${t.run}`, `Omnexx-Task: ${t.task}`, `Omnexx-Cycle: ${t.cycle}`];
  if (t.worker) lines.push(`Omnexx-Worker: ${t.worker}`);
  return lines.join('\n');
}

/** Parse Omnexx trailers from a full commit message. Undefined when any required trailer is missing. */
export function parseTrailers(message: string): OmnexxTrailers | undefined {
  const get = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(message)?.[1];
  const run = get('Omnexx-Run');
  const task = get('Omnexx-Task');
  const cycle = get('Omnexx-Cycle');
  if (!run || !task || !cycle || !/^\d+$/.test(cycle)) return undefined;
  const worker = get('Omnexx-Worker');
  return { run, task, cycle: Number(cycle), ...(worker ? { worker } : {}) };
}
