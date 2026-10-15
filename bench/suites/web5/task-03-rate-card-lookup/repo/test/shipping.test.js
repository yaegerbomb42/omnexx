import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingCost } from '../src/shipping.js';

test('returns a number', () => {
  assert.equal(typeof shippingCost('A', 1), 'number');
});
