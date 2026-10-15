import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ukToIso, shiftIso } from '../src/dates.js';

test('converts UK dates', () => {
  assert.equal(ukToIso('05/03/2026'), '2026-03-05');
});

test('shifts dates', () => {
  assert.equal(shiftIso('2026-03-05', 2), '2026-03-07');
});
