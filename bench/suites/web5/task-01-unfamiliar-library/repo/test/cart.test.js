import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.js';

test('adds two prices', () => {
  assert.equal(cartTotal(['1.50', '2.25']), '3.75');
});
