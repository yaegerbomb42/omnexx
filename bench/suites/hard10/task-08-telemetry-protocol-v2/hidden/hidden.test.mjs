import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.env.TASK_REPO;
const CSV = join(import.meta.dirname, 'readings.csv');
const dir = mkdtempSync(join(tmpdir(), 'telemetry-'));
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const emit = (...args) =>
  execFileSync('python3', [join(REPO, 'producer/emit.py'), '--input', CSV, ...args], {
    cwd: REPO,
    encoding: 'utf-8',
  });
const lines = (out) => out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
let n = 0;
const summarize = (text) => {
  const f = join(dir, `in${n++}.jsonl`);
  writeFileSync(f, text);
  return JSON.parse(execFileSync('node', [join(REPO, 'consumer/src/cli.ts'), f], { cwd: REPO, encoding: 'utf-8' }));
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.006, `${a} vs ${b}`);

test('v1 output is unchanged', () => {
  const want = [
    { sensor: 'boiler', ts: 1714557600, value: 20 },
    { sensor: 'boiler', ts: 1714557930, value: 26.85 },
    { sensor: 'attic', ts: 1714557600, value: 21.5 },
    { sensor: 'attic', ts: 1714523400, value: 19.25 },
  ];
  assert.deepEqual(lines(emit()), want);
  assert.deepEqual(lines(emit('--schema', '1')), want);
});

test('v2 output', () => {
  const got = lines(emit('--schema', '2'));
  assert.equal(got.length, 6);
  for (const r of got) {
    assert.equal(r.v, 2);
    assert.match(r.ts, ISO);
    assert.deepEqual(Object.keys(r).sort(), ['sensor', 'ts', 'unit', 'v', 'value']);
  }
  const simple = got.map((r) => [r.sensor, r.ts, r.value, r.unit]);
  assert.deepEqual(simple, [
    ['boiler', '2024-05-01T10:00:00.000Z', 68, 'F'],
    ['boiler', '2024-05-01T10:05:30.250Z', 300, 'K'],
    ['boiler', '2024-05-01T09:59:59.000Z', null, 'C'],
    ['attic', '2024-05-01T10:00:00.000Z', 21.5, 'C'],
    ['attic', '2024-05-01T00:30:00.000Z', 19.25, 'C'],
    ['cellar', '2024-05-01T10:00:00.000Z', null, 'F'],
  ]);
});

test('consumer: v2 file from the producer', () => {
  const s = summarize(emit('--schema', '2'));
  assert.equal(s.skipped, 0);
  assert.deepEqual(Object.keys(s.sensors).sort(), ['attic', 'boiler', 'cellar']);
  const b = s.sensors.boiler;
  assert.equal(b.count, 2);
  assert.equal(b.missing, 1);
  close(b.min, 20);
  close(b.max, 26.85);
  close(b.mean, 23.43);
  assert.equal(b.first, '2024-05-01T09:59:59.000Z');
  assert.equal(b.last, '2024-05-01T10:05:30.250Z');
  const c = s.sensors.cellar;
  assert.deepEqual([c.count, c.missing, c.min, c.max, c.mean], [0, 1, null, null, null]);
  assert.equal(c.first, '2024-05-01T10:00:00.000Z');
  assert.equal(s.sensors.attic.first, '2024-05-01T00:30:00.000Z');
});

test('consumer: v1 file and mixed file with junk', () => {
  const v1 = summarize(emit());
  assert.equal(v1.sensors.attic.count, 2);
  assert.equal(v1.sensors.attic.missing, 0);
  close(v1.sensors.attic.mean, 20.38);
  assert.equal(v1.sensors.attic.last, '2024-05-01T10:00:00.000Z');
  const mixed = [
    JSON.stringify({ sensor: 'x', ts: 1714557600, value: 10 }),
    JSON.stringify({ v: 2, sensor: 'x', ts: '2024-05-01T10:00:01.500Z', value: 32, unit: 'F' }),
    JSON.stringify({ v: 2, sensor: 'x', ts: '2024-05-01T09:00:00.000Z', value: null, unit: 'K' }),
    '',
    '   ',
    '{not json',
    JSON.stringify({ v: 3, sensor: 'x', ts: '2024-05-01T10:00:00.000Z', value: 1, unit: 'C' }),
    JSON.stringify({ v: 2, sensor: 'x', ts: '2024-05-01T10:00:00.000Z', value: 1, unit: 'R' }),
    JSON.stringify({ v: 2, sensor: 'x', ts: '2024-05-01T10:00:00.000Z', value: '1', unit: 'C' }),
    JSON.stringify({ sensor: 'x', ts: 'yesterday', value: 1 }),
    JSON.stringify({ ts: 1714557600, value: 1 }),
    JSON.stringify({ v: 2, sensor: 'y', ts: '2024-05-01T10:00:00.000Z', value: 0, unit: 'K' }),
  ].join('\n');
  const s = summarize(mixed);
  assert.equal(s.skipped, 6);
  const x = s.sensors.x;
  assert.deepEqual([x.count, x.missing], [2, 1]);
  close(x.min, 0);
  close(x.max, 10);
  close(x.mean, 5);
  assert.equal(x.first, '2024-05-01T09:00:00.000Z');
  assert.equal(x.last, '2024-05-01T10:00:01.500Z');
  close(s.sensors.y.min, -273.15);
});
