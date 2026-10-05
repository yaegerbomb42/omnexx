import { open, stat } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import type { Brand } from '../cli/brand.js';
import type { OmnexxEvent } from '../core/events.js';
import { emptyTelemetry, fold, cacheHitRate, type Telemetry } from './aggregate.js';
import { fmtMs, fmtTokens, humanize, type Verbosity } from './humanize.js';

/**
 * Tails an events.jsonl from a byte offset (never re-reads the whole file), so a feed over a
 * days-long run stays cheap. A shrinking file means it was rotated: start again from 0.
 */
export class EventTail {
  private offset = 0;
  private partial = '';

  constructor(readonly path: string) {}

  async read(): Promise<OmnexxEvent[]> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];
    const fh = await open(this.path, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      await fh.read(buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      const out: OmnexxEvent[] = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l) as OmnexxEvent);
        } catch {
          // A torn line from a crash: skip it, the next event is intact.
        }
      }
      return out;
    } finally {
      await fh.close();
    }
  }
}

export interface FeedOptions {
  out: Writable;
  brand: Brand;
  verbosity: Verbosity;
  /** Redraw a one-line status footer under the feed (TTY only). */
  footer?: boolean;
  intervalMs?: number;
  now?: () => number;
}

/** One-line status: elapsed · cycle · task · model · tokens · cache · $ · commits. */
export function statusLine(t: Telemetry, b: Brand, now: number): string {
  const elapsed = t.startedAt ? fmtMs(now - t.startedAt) : '0s';
  const tokens = fmtTokens(t.tokens.input + t.tokens.output);
  const parts = [
    b.green('omnexx'),
    elapsed,
    `cycle ${t.cycle}`,
    t.task ? `task ${t.task}` : undefined,
    t.model ? b.cyan(t.model) : undefined,
    `${tokens} tok`,
    `cache ${Math.round(cacheHitRate(t) * 100)}%`,
    `$${t.usd.toFixed(2)}`,
    `${b.green(`✓${t.commits}`)} ${t.rejects ? b.red(`✗${t.rejects}`) : '✗0'}`,
  ];
  return parts.filter(Boolean).join(b.dim(' · '));
}

/** Streams humanized events to `out` until `stop()` is called. */
export class LiveFeed {
  readonly telemetry = emptyTelemetry();
  private timer: NodeJS.Timeout | undefined;
  private footerShown = false;
  private busy = false;

  constructor(
    private readonly tail: EventTail,
    private readonly opts: FeedOptions,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 250);
    this.timer.unref();
  }

  private stopped = false;

  /** Idempotent: flush what's left, clear the footer, stop polling. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.opts.footer = false;
    await this.tick();
    this.clearFooter();
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const events = await this.tail.read();
      if (!events.length && !this.opts.footer) return;
      this.clearFooter();
      for (const e of events) {
        fold(this.telemetry, e);
        const line = humanize(e, { brand: this.opts.brand, verbosity: this.opts.verbosity });
        if (line) this.opts.out.write(`${line}\n`);
      }
      if (this.opts.footer) {
        const now = (this.opts.now ?? Date.now)();
        this.opts.out.write(statusLine(this.telemetry, this.opts.brand, now));
        this.footerShown = true;
      }
    } finally {
      this.busy = false;
    }
  }

  private clearFooter(): void {
    if (!this.footerShown) return;
    this.opts.out.write('\r\x1b[2K');
    this.footerShown = false;
  }
}
