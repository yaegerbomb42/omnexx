import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../../src/core/events.js';
import { realClock } from '../../src/core/clock.js';
import { Redactor } from '../../src/security/redact.js';

async function benchmark() {
  const root = await mkdtemp(join(tmpdir(), 'omnexx-bench-'));
  const logPath = join(root, 'events.jsonl');
  const redactor = new Redactor();
  const clock = realClock;
  const log = new EventLog(logPath, 'bench-run', redactor, clock, 1024 * 1024);

  const eventCount = 50000;
  const payloadSize = 200;
  const payload = 'x'.repeat(payloadSize);

  const startMem = process.memoryUsage().heapUsed;
  console.log(`Starting heap: ${(startMem / 1024 / 1024).toFixed(2)} MB`);

  for (let i = 0; i < eventCount; i++) {
    log.emit('test', { data: payload, index: i });
    if (i % 10000 === 0) {
      const mem = process.memoryUsage().heapUsed;
      console.log(`After ${i} events: ${(mem / 1024 / 1024).toFixed(2)} MB, buffered: ${log.bufferedEvents}`);
    }
  }

  const endMem = process.memoryUsage().heapUsed;
  console.log(`Final heap: ${(endMem / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap growth: ${((endMem - startMem) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Buffered events: ${log.bufferedEvents}`);
  console.log(`Expected max buffered: ${1000}`);

  await rm(root, { recursive: true, force: true });
}

benchmark().catch(console.error);