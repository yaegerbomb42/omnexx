#!/usr/bin/env bash
set -euo pipefail

# Hidden acceptance tests, written outside the repo and run against its code.
REPO="$PWD"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
npm test > /dev/null 2>&1
grep -q "vendor/tallyhq" src/cart.js
cat > "$H/hidden.test.mjs" << EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '$REPO/src/cart.js';
test('rounds the total half to even', () => {
  assert.equal(cartTotal(['0.125']), '0.12');
  assert.equal(cartTotal(['0.135']), '0.14');
  assert.equal(cartTotal(['0.0625', '0.0625']), '0.12');
  assert.equal(cartTotal(['2.675']), '2.68');
});
test('exact decimal sums', () => {
  assert.equal(cartTotal(['0.1', '0.2']), '0.30');
  assert.equal(cartTotal(['19.99', '0.01', '5']), '25.00');
});
test('empty cart', () => {
  assert.equal(cartTotal([]), '0.00');
});
EOF
node --test "$H/hidden.test.mjs"
