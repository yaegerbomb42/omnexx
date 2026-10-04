import { join } from 'node:path';
import { z } from 'zod';
import { readTextOr, writeJsonAtomic } from '../core/atomic.js';
import type { QuotaPolicy, WorkerStatus } from './types.js';

const entrySchema = z.object({
  runs: z.array(z.number()).default([]),
  cooldownUntil: z.number().optional(),
  lastStatus: z.string().optional(),
});
const fileSchema = z.record(z.string(), entrySchema);
type QuotaFile = z.infer<typeof fileSchema>;

const HOUR = 3_600_000;

/** Per-worker usage and cooldowns, persisted in `$OMNEXX_HOME/workers/state.json` across runs and restarts. */
export class QuotaStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, 'workers', 'state.json');
  }

  private async read(): Promise<QuotaFile> {
    const text = await readTextOr(this.path, '{}');
    const parsed = fileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  }

  /** Why the worker may not run now, or undefined if it may. */
  async blocked(id: string, policy: QuotaPolicy, now: number): Promise<string | undefined> {
    const e = (await this.read())[id];
    if (!e) return undefined;
    if (e.cooldownUntil !== undefined && e.cooldownUntil > now)
      return `cooling down until ${new Date(e.cooldownUntil).toISOString()} (${e.lastStatus ?? ''})`;
    const hour = e.runs.filter((t) => now - t < HOUR).length;
    const day = e.runs.filter((t) => now - t < 24 * HOUR).length;
    if (hour >= policy.maxRunsPerHour)
      return `${hour} runs in the last hour (cap ${policy.maxRunsPerHour})`;
    if (day >= policy.maxRunsPerDay)
      return `${day} runs in the last day (cap ${policy.maxRunsPerDay})`;
    return undefined;
  }

  async record(id: string, status: WorkerStatus, policy: QuotaPolicy, now: number): Promise<void> {
    const all = await this.read();
    const e = all[id] ?? { runs: [] };
    e.runs = [...e.runs.filter((t) => now - t < 24 * HOUR), now];
    e.lastStatus = status;
    if (status === 'quota_exhausted' || status === 'rate_limited')
      e.cooldownUntil = now + policy.cooldownMs;
    all[id] = e;
    await writeJsonAtomic(this.path, all);
  }
}

/** Caps how many workers run at once (`[workers] max_concurrent`). FIFO. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  peak = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}
