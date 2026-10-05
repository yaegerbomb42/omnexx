import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';

test('two plus two is four', () => {
  assert.equal(add(2, 2), 4);
});

test('two plus two is five', () => {
  assert.equal(add(2, 2), 5);
});
