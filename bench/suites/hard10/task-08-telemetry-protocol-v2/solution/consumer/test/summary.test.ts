import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summary.ts';
import { parseLine } from '../src/parse.ts';

test('summarize', () => {
  const s = summarize([
    { sensor: 'a', ts: 1000, value: 1 },
    { sensor: 'a', ts: 2000, value: 3 },
    { sensor: 'a', ts: 500, value: null },
  ]);
  assert.deepEqual(s.a, {
    count: 2,
    missing: 1,
    min: 1,
    max: 3,
    mean: 2,
    first: '1970-01-01T00:00:00.500Z',
    last: '1970-01-01T00:00:02.000Z',
  });
});

test('parseLine handles v1, v2 and junk', () => {
  assert.deepEqual(parseLine('{"sensor":"a","ts":1,"value":2}'), { sensor: 'a', ts: 1000, value: 2 });
  assert.equal(parseLine('{"v":2,"sensor":"a","ts":"1970-01-01T00:00:01.000Z","value":32,"unit":"F"}')?.value, 0);
  assert.equal(parseLine('{oops'), null);
  assert.equal(parseLine('{"v":2,"sensor":"a","ts":"x","value":1,"unit":"C"}'), null);
});
