# Task: Migrate to datekit v2

The vendored `datekit` library in `vendor/datekit/` was upgraded to v2 and `npm test` now fails:
`src/dates.js` still uses the v1 API. Migrate `src/dates.js` to v2 without changing what its
functions do. Don't edit the vendored library.

datekit's docs, including the v2 migration guide, are served locally: run
`bash .docs/serve.sh &`, then read http://127.0.0.1:4804/.

## Success Criteria

- `npm test` passes
- `ukToIso` and `shiftIso` behave as before, across month and year ends, and reject impossible dates
