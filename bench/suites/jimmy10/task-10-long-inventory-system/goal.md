# Task: Build an Inventory Library (long, multi-milestone)

Build an in-memory inventory library in `src/` from this spec. It is deliberately large: plan it
in milestones. Export everything from `src/index.js`.

1. `createInventory()` returns an inventory object.
2. `addProduct({ sku, name, price, reorderLevel = 0 })`: sku unique (throw `InventoryError` with `code: 'DUPLICATE_SKU'`), price >= 0 (`code: 'INVALID_PRICE'`).
3. `getProduct(sku)` returns a copy (mutating it must not change the inventory) or `null`.
4. `receive(sku, qty)` adds stock; `ship(sku, qty)` removes it; shipping more than on hand throws `code: 'INSUFFICIENT_STOCK'` and changes nothing. Unknown sku: `code: 'UNKNOWN_SKU'`. qty must be a positive integer (`code: 'INVALID_QTY'`).
5. `stock(sku)` returns on-hand quantity.
6. Every receive/ship appends to a ledger: `history(sku)` returns `[{ type: 'receive'|'ship', qty, balance }]` in order.
7. `lowStock()` returns skus whose stock is <= their reorderLevel, sorted.
8. `valuation()` returns the total of stock x price over all products, rounded to cents.
9. Reservations: `reserve(sku, qty)` returns a reservation id and lowers the stock available to `ship` and `reserve` without changing `stock()`; `release(id)` undoes it; `fulfil(id)` ships the reserved quantity. `available(sku)` = stock - reserved. Unknown id: `code: 'UNKNOWN_RESERVATION'`.
10. `snapshot()` returns a JSON string of the whole state; `restoreInventory(json)` (a top-level export) rebuilds an equal inventory, including history and open reservations.
11. `transfer(fromInv, toInv, sku, qty)` (top-level export) moves stock between inventories that both have the sku, atomically: on any error neither side changes.

## Success Criteria

- `npm test` passes, with tests for every numbered rule
