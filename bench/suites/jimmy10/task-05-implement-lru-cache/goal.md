# Task: Implement an LRU Cache

Implement `LRUCache` in `src/lru.js` (the file has a stub that throws).

- `new LRUCache(capacity)`; capacity is a positive integer, otherwise throw a `RangeError`
- `get(key)` returns the value or `undefined`, and marks the key most recently used
- `set(key, value)` inserts or updates; when over capacity, evict the least recently used key
- `has(key)` (does not change recency), `delete(key)`, and a `size` getter
- All operations O(1)

## Success Criteria

- `npm test` passes with tests you add for the behaviour above
