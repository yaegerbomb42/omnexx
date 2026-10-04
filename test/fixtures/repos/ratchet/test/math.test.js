import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, legacyRound } from '../src/math.js';

test('add adds', () => {
  assert.equal(add(2, 3), 5);
});

test('legacy rounding (known broken before this run)', () => {
  assert.equal(legacyRound(2.5), 3);
});
