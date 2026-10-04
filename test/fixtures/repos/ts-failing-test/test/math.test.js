import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';

test('add adds', () => {
  assert.equal(add(2, 3), 5);
});

test('add is commutative', () => {
  assert.equal(add(4, 1), add(1, 4));
});
