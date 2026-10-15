#!/usr/bin/env bash
set -euo pipefail

# Hidden acceptance tests, written outside the repo and run against its code.
REPO="$PWD"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
npm test > /dev/null 2>&1
cat > "$H/hidden.test.mjs" << EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingCost } from '$REPO/src/shipping.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, a + ' != ' + b);
test('base plus per-kg for whole kilograms', () => {
  near(shippingCost('A', 1), 5.05);
  near(shippingCost('B', 2), 7.4);
  near(shippingCost('A', 10), 12.7);
});
test('weight rounds up, minimum 1 kg', () => {
  near(shippingCost('A', 0.2), 5.05);
  near(shippingCost('B', 2.01), 8.55);
});
test('zone C remote surcharge', () => {
  near(shippingCost('C', 3), 15.05);
});
test('refuses unknown zones and overweight parcels', () => {
  assert.throws(() => shippingCost('D', 1), RangeError);
  assert.throws(() => shippingCost('A', 30.5), RangeError);
  near(shippingCost('A', 30), 29.7);
});
EOF
node --test "$H/hidden.test.mjs"
