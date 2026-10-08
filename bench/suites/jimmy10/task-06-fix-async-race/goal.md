# Task: Fix the Concurrent Fetch Bug

`loadAll` in `src/loader.js` should fetch every id with at most `limit` requests in flight and
return results in the same order as the ids. Under load, results come back out of order and the
concurrency limit is sometimes exceeded. Fix it without changing the signature.

## Success Criteria

- `npm test` passes
- Results are in input order; never more than `limit` calls run at once; a rejection rejects `loadAll`
