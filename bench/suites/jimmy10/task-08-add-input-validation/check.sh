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
import { createOrder, ValidationError } from '$REPO/src/orders.js';
const ok = { customerId: 'c1', items: [{ sku: 'A', qty: 2, price: 5 }] };
const bad = (patch, field) => {
  assert.throws(() => createOrder({ ...ok, ...patch }), (e) => e instanceof ValidationError && e.field === field);
};
test('valid order unchanged', () => {
  assert.equal(createOrder(ok).total, 10);
  assert.equal(createOrder({ ...ok, coupon: 'SAVE10' }).total, 9);
});
test('each rule', () => {
  bad({ customerId: '' }, 'customerId');
  bad({ items: [] }, 'items');
  bad({ items: [{ sku: '', qty: 1, price: 1 }] }, 'sku');
  bad({ items: [{ sku: 'A', qty: 0, price: 1 }] }, 'qty');
  bad({ items: [{ sku: 'A', qty: 1.5, price: 1 }] }, 'qty');
  bad({ items: [{ sku: 'A', qty: 101, price: 1 }] }, 'qty');
  bad({ items: [{ sku: 'A', qty: 1, price: -1 }] }, 'price');
  bad({ items: [{ sku: 'A', qty: 1, price: Infinity }] }, 'price');
  bad({ coupon: 'bad!' }, 'coupon');
});
EOF
node --test "$H/hidden.test.mjs"
