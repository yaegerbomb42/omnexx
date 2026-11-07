import { readdirSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventLog, readEvents } from '../../../src/core/events.js';
import { realClock } from '../../../src/core/clock.js';
import { Redactor } from '../../../src/security/redact.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'omnexx-events-'));
  dirs.push(d);
  return d;
}

describe('EventLog', () => {
  const redactor = new Redactor();
  const clock = realClock;

  it('appends events to the log file', async () => {
    const root = await dir();
    const logPath = join(root, 'events.jsonl');
    const log = new EventLog(logPath, 'run-1', redactor, clock);

    log.emit('test', { foo: 'bar' });
    log.emit('test', { baz: 123 });

    const events = await readEvents(logPath);
    expect(events).toHaveLength(2);
    const [e0, e1] = events;
    if (e0) expect(e0.type).toBe('test');
    if (e0) expect(e0.foo).toBe('bar');
    if (e1) expect(e1.type).toBe('test');
    if (e1) expect(e1.baz).toBe(123);
  });

  it('rotates the log when it exceeds the rotate threshold', async () => {
    const root = await dir();
    const logPath = join(root, 'events.jsonl');
    const log = new EventLog(logPath, 'run-1', redactor, clock, 100);

    for (let i = 0; i < 10; i++) {
      log.emit('test', { data: 'x'.repeat(20) });
    }

    const segments = readdirSync(root).filter((f) => f.startsWith('events.jsonl'));
    expect(segments.length).toBeGreaterThan(1);
  });

  it('keeps the in-memory buffer bounded while still persisting every event', async () => {
    const root = await dir();
    const logPath = join(root, 'events.jsonl');
    const log = new EventLog(logPath, 'run-1', redactor, clock);

    for (let i = 0; i < 1500; i++) {
      log.emit('test', { i });
    }

    expect(log.bufferedEvents).toBeLessThanOrEqual(1000);

    const events = await readEvents(logPath);
    expect(events.length).toBe(1500);
  });

  it('getAllEvents reads from all segments after rotation', async () => {
    const root = await dir();
    const logPath = join(root, 'events.jsonl');
    const log = new EventLog(logPath, 'run-1', redactor, clock, 100);

    for (let i = 0; i < 5; i++) {
      log.emit('test', { i });
    }

    const all = await log.getAllEvents();
    expect(all.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      const ev = all[i];
      if (ev) expect(ev.i).toBe(i);
    }
  });

  it('reads segments in rotation order, not directory order, past ten rotations', async () => {
    const root = await dir();
    const logPath = join(root, 'events.jsonl');

    // `readdir` sorts names as strings: `events.jsonl.10` comes before `events.jsonl.2`.
    const emit = (seg: number, i: number): string =>
      `${JSON.stringify({ ts: seg, runId: 'run-1', cycle: 0, type: 'test', i })}\n`;
    for (let seg = 1; seg <= 11; seg++) {
      const name = seg === 11 ? 'events.jsonl' : `events.jsonl.${seg}`;
      await writeFile(join(root, name), emit(seg, seg));
    }

    const log = new EventLog(logPath, 'run-1', redactor, clock);
    const all = await log.getAllEvents();
    expect(all.map((e) => e.i)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('drops stale segments on construction', async () => {
    const root = await dir();
    const logPath = join(root, 'events.jsonl');
    await writeFile(logPath, '');
    const staleSeg = join(root, 'events.jsonl.1');
    await writeFile(staleSeg, '{"ts":1,"runId":"x","cycle":0,"type":"test"}\n');
    await utimes(staleSeg, new Date(0), new Date(0));
    await writeFile(join(root, 'events.jsonl.2'), '{"ts":2,"runId":"x","cycle":0,"type":"test"}\n');

    const log = new EventLog(logPath, 'run-1', redactor, clock);
    const segments = readdirSync(root).filter((f) => f.startsWith('events.jsonl.'));
    expect(segments).toEqual(['events.jsonl.2']);
    expect(log.bufferedEvents).toBe(0);
  });
});
