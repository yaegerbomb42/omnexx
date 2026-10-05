import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

/**
 * Append-only JSONL. Every event goes through the redactor before it touches disk. Writes are
 * synchronous so the order on disk is the order things happened, even right before a crash.
 */
export class EventLog {
  cycle = 0;
  private readonly listeners: ((e: OmnexxEvent) => void)[] = [];

  constructor(
    readonly path: string,
    readonly runId: string,
    private readonly redactor: Redactor,
    private readonly clock: Clock,
    private readonly rotateBytes = EVENT_ROTATE_BYTES,
  ) {}

  emit(type: string, data: Record<string, unknown> = {}): OmnexxEvent {
    const event = this.redactor.value({
      ts: this.clock.now(),
      runId: this.runId,
      cycle: this.cycle,
      type,
      ...data,
    });
    this.rotateIfNeeded();
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    for (const l of this.listeners) l(event);
    return event;
  }

  onEvent(listener: (e: OmnexxEvent) => void): void {
    this.listeners.push(listener);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size < this.rotateBytes) return;
    let n = 1;
    while (existsSync(`${this.path}.${n}`)) n++;
    renameSync(this.path, `${this.path}.${n}`);
  }
}

export async function readEvents(path: string): Promise<OmnexxEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
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
      // A torn final line from a crash mid-append is skipped; everything before it is intact.
    }
  }
  return out;
}
