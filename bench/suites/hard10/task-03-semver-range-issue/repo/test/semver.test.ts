import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, satisfies } from '../src/index.ts';

test('compare basics', () => {
  assert.equal(compare('1.2.3', '1.2.4'), -1);
  assert.equal(compare('2.0.0', '1.9.9'), 1);
  assert.equal(compare('1.0.0+build.1', '1.0.0'), 0);
});

test('ranges', () => {
  assert.ok(satisfies('1.4.0', '^1.2.3'));
  assert.ok(!satisfies('2.0.0', '^1.2.3'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(satisfies('3.0.0', '<2.0.0 || >=3.0.0'));
});
