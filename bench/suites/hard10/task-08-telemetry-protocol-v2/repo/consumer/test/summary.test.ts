import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summary.ts';

test('summarize', () => {
  const s = summarize([
    { sensor: 'a', ts: 1, value: 1 },
    { sensor: 'a', ts: 2, value: 3 },
  ]);
  assert.deepEqual(s.a, { count: 2, min: 1, max: 3, mean: 2 });
});
