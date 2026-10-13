#!/usr/bin/env bash
set -euo pipefail

# Hidden acceptance tests, written outside the repo and run against its code.
REPO="$PWD"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
npm test >/dev/null 2>&1
cat > "$H/hidden.test.mjs" << EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '$REPO/src/lru.js';
test('evicts least recently used, get refreshes', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.has('b'), false); assert.equal(c.get('a'), 1); assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});
test('update keeps size, has does not refresh, delete works', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.set('a', 9);
  assert.equal(c.size, 2); assert.equal(c.get('a'), 9);
  c.has('b'); c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.delete('a'), true); assert.equal(c.size, 1); assert.equal(c.get('missing'), undefined);
});
test('bad capacity throws RangeError', () => {
  for (const bad of [0, -1, 1.5, 'x']) assert.throws(() => new LRUCache(bad), RangeError);
});
EOF
node --test "$H/hidden.test.mjs"
