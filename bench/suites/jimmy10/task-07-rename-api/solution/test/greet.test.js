import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';
import { getUser } from '../src/user.js';
test('greets', () => {
  assert.equal(greet(1), 'Hello, Ada');
  assert.equal(getUser(9), null);
});
