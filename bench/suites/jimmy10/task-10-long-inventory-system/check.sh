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
import * as lib from '$REPO/src/index.js';
const { createInventory, restoreInventory, transfer, InventoryError } = lib;
const code = (fn, c) => assert.throws(fn, (e) => e instanceof InventoryError && e.code === c);
const mk = () => { const i = createInventory(); i.addProduct({ sku: 'A', name: 'Apple', price: 0.5, reorderLevel: 5 }); i.addProduct({ sku: 'B', name: 'Bolt', price: 1.25 }); return i; };
test('products', () => {
  const i = mk();
  code(() => i.addProduct({ sku: 'A', name: 'x', price: 1 }), 'DUPLICATE_SKU');
  code(() => i.addProduct({ sku: 'C', name: 'x', price: -1 }), 'INVALID_PRICE');
  const p = i.getProduct('A'); p.price = 99; assert.equal(i.getProduct('A').price, 0.5);
  assert.equal(i.getProduct('Z'), null);
});
test('stock, errors, history', () => {
  const i = mk();
  i.receive('A', 10); i.ship('A', 3);
  assert.equal(i.stock('A'), 7);
  code(() => i.ship('A', 8), 'INSUFFICIENT_STOCK'); assert.equal(i.stock('A'), 7);
  code(() => i.receive('Z', 1), 'UNKNOWN_SKU');
  code(() => i.receive('A', 0), 'INVALID_QTY'); code(() => i.receive('A', 1.5), 'INVALID_QTY');
  assert.deepEqual(i.history('A'), [{ type: 'receive', qty: 10, balance: 10 }, { type: 'ship', qty: 3, balance: 7 }]);
});
test('low stock and valuation', () => {
  const i = mk(); i.receive('A', 5); i.receive('B', 3);
  assert.deepEqual(i.lowStock(), ['A']);
  assert.equal(i.valuation(), 6.25);
});
test('reservations', () => {
  const i = mk(); i.receive('A', 10);
  const r = i.reserve('A', 6);
  assert.equal(i.stock('A'), 10); assert.equal(i.available('A'), 4);
  code(() => i.ship('A', 5), 'INSUFFICIENT_STOCK'); code(() => i.reserve('A', 5), 'INSUFFICIENT_STOCK');
  i.fulfil(r); assert.equal(i.stock('A'), 4); assert.equal(i.available('A'), 4);
  const r2 = i.reserve('A', 2); i.release(r2); assert.equal(i.available('A'), 4);
  code(() => i.release('nope'), 'UNKNOWN_RESERVATION');
});
test('snapshot round trip', () => {
  const i = mk(); i.receive('A', 10); const r = i.reserve('A', 2);
  const j = restoreInventory(i.snapshot());
  assert.equal(j.snapshot(), i.snapshot());
  assert.equal(j.available('A'), 8); j.fulfil(r); assert.equal(j.stock('A'), 8);
  assert.deepEqual(j.history('A').at(-1), { type: 'ship', qty: 2, balance: 8 });
});
test('atomic transfer', () => {
  const a = mk(), b = mk(); a.receive('A', 5);
  transfer(a, b, 'A', 3); assert.equal(a.stock('A'), 2); assert.equal(b.stock('A'), 3);
  code(() => transfer(a, b, 'A', 9), 'INSUFFICIENT_STOCK');
  const c = createInventory();
  code(() => transfer(a, c, 'A', 1), 'UNKNOWN_SKU'); assert.equal(a.stock('A'), 2);
});
EOF
node --test "$H/hidden.test.mjs"
