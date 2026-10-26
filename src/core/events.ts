import { appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { Redactor } from '../security/redact.js';
import type { Clock } from './clock.js';

export interface OmnexxEvent {
  ts: number;
  runId: string;
  cycle: number;
  type: string;
  [key: string]: unknown;
}

export const EVENT_ROTATE_BYTES = 50 * 1024 * 1024;
export const EVENT_INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const EVENT_BUFFER_MAX_EVENTS = 1000;

export class EventLog {
  cycle = 0;
  private readonly listeners: ((e: OmnexxEvent) => void)[] = [];
  private buffer: OmnexxEvent[] = [];

  get bufferedEvents(): number {
    return this.buffer.length;
  }

  constructor(
    readonly path: string,
    readonly runId: string,
    private readonly redactor: Redactor,
    private readonly clock: Clock,
    private readonly rotateBytes = EVENT_ROTATE_BYTES,
  ) {
    this.loadIndex();
  }

  emit(type: string, data: Record<string, unknown> = {}): OmnexxEvent {
    const event = this.redactor.value({
      ts: this.clock.now(),
      runId: this.runId,
      cycle: this.cycle,
      type,
      ...data,
    });
    this.rotateIfNeeded();
    this.buffer.push(event);
    if (this.buffer.length >= EVENT_BUFFER_MAX_EVENTS) {
      this.flush();
    }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    for (const l of this.listeners) l(event);
    return event;
  }

  onEvent(listener: (e: OmnexxEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private flush(): void {
    this.buffer = [];
  }

  async getAllEvents(): Promise<OmnexxEvent[]> {
    const segments = this.listSegments();
    const events: OmnexxEvent[] = [];
    const readLines = async (p: string): Promise<void> => {
      const text = await readFileAsync(p, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as OmnexxEvent);
        } catch {
          // A torn final line from a crash mid-append is skipped.
        }
      }
    };
    for (const seg of segments) await readLines(this.segmentPath(seg));
    if (existsSync(this.path)) await readLines(this.path);
    return events;
  }

  private listSegments(): number[] {
    const dir = dirname(this.path);
    const base = basename(this.path);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`) && f !== base)
        .map((f) => parseInt(f.slice(base.length + 1), 10))
        .filter((n) => !isNaN(n));
    } catch {
      return [];
    }
  }

  private segmentPath(seg: number): string {
    return `${this.path}.${seg}`;
  }

  private loadIndex(): void {
    const segments = this.listSegments();
    const now = this.clock.now();
    for (const seg of segments) {
      const segPath = this.segmentPath(seg);
      if (statSync(segPath).size === 0) {
        unlinkSync(segPath);
        continue;
      }
      const age = now - statSync(segPath).mtimeMs;
      if (age > EVENT_INDEX_MAX_AGE_MS) {
        unlinkSync(segPath);
        continue;
      }
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size < this.rotateBytes) return;
    let n = 1;
    while (existsSync(`${this.path}.${n}`)) n++;
    renameSync(this.path, `${this.path}.${n}`);
    this.flush();
  }
}

export async function readEvents(path: string): Promise<OmnexxEvent[]> {
  let text: string;
  try {
    text = await readFileAsync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: OmnexxEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OmnexxEvent);
    } catch {
      // A torn final line from a crash mid-append is skipped.
    }
  }
  return out;
}
